/**
 * Unit Tests: importance + reinforce-recency ingest, end-to-end (harvest-07 / D1)
 *
 * The recon-side foundation for decay-weighted retrieval (harvest-09). At
 * index/serve, two per-page signals are carried onto prose Page nodes:
 *   - importance  — `importance:` frontmatter, else the tier prior
 *   - lastReinforced — from the `.wrxn/reinforce.json` recency sidecar, joined
 *                      by the page's WIKI-ROOT-RELATIVE path (the pinned key
 *                      harvest-08 stamps)
 *
 * Proves the signals survive the real ingest path + round-trip the store(s)
 * (JSON + SQLite), and that this is PURE INGEST — retrieval ranking is unchanged
 * (AC4). Temp-dir style mirrors markdown-index-project.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProject } from '../../src/cli/commands.js';
import { loadIndex } from '../../src/storage/store.js';
import { SqliteStore } from '../../src/storage/sqlite.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { executeFind } from '../../src/mcp/find.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { TIER_PRIORS, NEUTRAL_IMPORTANCE } from '../../src/analyzers/prose-signals.js';

// ─── AC1+AC2+AC3: real ingest path with a recency sidecar ─────────

const REPO = 'sigrepo';
let extDir: string;
let mainRoot: string;

beforeAll(async () => {
  extDir = mkdtempSync(join(tmpdir(), 'recon-sig-'));
  mainRoot = mkdtempSync(join(tmpdir(), 'recon-sig-main-'));
  mkdirSync(join(extDir, '.wrxn', 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(extDir, '.wrxn', 'wiki', 'gotchas'), { recursive: true });
  mkdirSync(join(extDir, 'docs'), { recursive: true });

  // A concepts page WITH explicit importance AND a recency entry.
  writeFileSync(
    join(extDir, '.wrxn', 'wiki', 'concepts', 'foo.md'),
    '---\ntitle: Foo\nimportance: 0.8\n---\n# Foo\nFoo body.\n',
  );
  // A gotchas page WITHOUT importance (→ tier prior) and NOT in the sidecar.
  writeFileSync(
    join(extDir, '.wrxn', 'wiki', 'gotchas', 'bar.md'),
    '---\ntitle: Bar\n---\n# Bar\nBar body.\n',
  );
  // A non-wiki page (→ neutral importance, never any recency).
  writeFileSync(join(extDir, 'docs', 'plain.md'), '# Plain\nPlain body.\n');

  // The coalesced recency sidecar — keyed by WIKI-ROOT-RELATIVE path (the pinned
  // cross-repo contract). Only foo.md has an entry.
  writeFileSync(
    join(extDir, '.wrxn', 'reinforce.json'),
    JSON.stringify({ 'concepts/foo.md': '2026-06-17' }),
  );

  await indexProject(extDir, mainRoot, REPO);
});

afterAll(() => {
  rmSync(extDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

describe('importance + recency ingest — end-to-end through the JSON store', () => {
  it('carries importance:0.8 AND the reinforce timestamp onto the matching page (AC1+AC2)', async () => {
    const stored = await loadIndex(mainRoot, REPO);
    const foo = stored!.graph.getNode('md:page:.wrxn/wiki/concepts/foo.md');
    expect(foo).toBeDefined();
    expect(foo!.importance).toBe(0.8);
    expect(foo!.lastReinforced).toBe('2026-06-17');
  });

  it('defaults a page with no importance to its tier prior, and no sidecar entry → no recency', async () => {
    const stored = await loadIndex(mainRoot, REPO);
    const bar = stored!.graph.getNode('md:page:.wrxn/wiki/gotchas/bar.md');
    expect(bar).toBeDefined();
    expect(bar!.importance).toBe(TIER_PRIORS.gotchas);
    expect('lastReinforced' in bar!).toBe(false);
  });

  it('defaults a non-wiki page to NEUTRAL importance and never stamps recency', async () => {
    const stored = await loadIndex(mainRoot, REPO);
    const plain = stored!.graph.getNode('md:page:docs/plain.md');
    expect(plain).toBeDefined();
    expect(plain!.importance).toBe(NEUTRAL_IMPORTANCE);
    expect('lastReinforced' in plain!).toBe(false);
  });
});

// ─── AC2: absent sidecar is graceful (serve unaffected) ───────────

describe('importance + recency ingest — absent sidecar is graceful', () => {
  it('indexes prose with importance but no recency when .wrxn/reinforce.json is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-nosig-'));
    const main = mkdtempSync(join(tmpdir(), 'recon-nosig-main-'));
    try {
      mkdirSync(join(dir, '.wrxn', 'wiki', 'concepts'), { recursive: true });
      writeFileSync(
        join(dir, '.wrxn', 'wiki', 'concepts', 'foo.md'),
        '---\nimportance: 0.5\n---\n# Foo\nbody\n',
      );

      await indexProject(dir, main, 'nosig');

      const stored = await loadIndex(main, 'nosig');
      const foo = stored!.graph.getNode('md:page:.wrxn/wiki/concepts/foo.md');
      expect(foo!.importance).toBe(0.5);
      expect('lastReinforced' in foo!).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });
});

// ─── AC3: both signals round-trip the SQLite store (via the meta blob) ──

describe('importance + recency round-trip the SQLite store', () => {
  it('preserves importance + lastReinforced on a Page node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-sig-sqlite-'));
    const store = new SqliteStore(dir);
    try {
      store.insertNode({
        id: 'md:page:.wrxn/wiki/concepts/foo.md',
        type: NodeType.Page,
        name: 'Foo',
        file: '.wrxn/wiki/concepts/foo.md',
        startLine: 1,
        endLine: 5,
        language: Language.Markdown,
        package: '.wrxn/wiki/concepts',
        exported: false,
        importance: 0.8,
        lastReinforced: '2026-06-17',
      });

      const node = store.getNode('md:page:.wrxn/wiki/concepts/foo.md');
      expect(node!.importance).toBe(0.8);
      expect(node!.lastReinforced).toBe('2026-06-17');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── AC4: PURE INGEST — retrieval ranking is byte-identical ───────

/** Build a small mixed graph; optionally stamp the (inert) decay signals. */
function buildGraph(withSignals: boolean): KnowledgeGraph {
  const g = new KnowledgeGraph();
  const sig = (imp: number): Partial<Node> =>
    withSignals ? { importance: imp, lastReinforced: '2026-06-17' } : {};

  const page = (file: string, name: string, imp: number): Node => ({
    id: `md:page:${file}`,
    type: NodeType.Page,
    name,
    file,
    startLine: 1,
    endLine: 5,
    language: Language.Markdown,
    package: '',
    exported: false,
    ...sig(imp),
  });

  // Two prose pages + one code symbol, all matching the query "auth". The
  // signals are deliberately ANTI-correlated with name order so that, if
  // importance leaked into ranking, the order WOULD change.
  g.addNode(page('.wrxn/wiki/concepts/auth.md', 'Authentication', 0.1));
  g.addNode(page('.wrxn/wiki/gotchas/auth.md', 'Auth Gotcha', 0.99));
  g.addNode({
    id: 'ts:func:authLogin',
    type: NodeType.Function,
    name: 'authLogin',
    file: 'src/auth.ts',
    startLine: 1,
    endLine: 9,
    language: Language.TypeScript,
    package: 'src',
    exported: true,
    ...sig(0.2),
  });
  return g;
}

describe('importance + recency are inert in retrieval ranking (AC4)', () => {
  it('executeFind returns byte-identical results with and without the signals', () => {
    for (const query of ['auth', 'authLogin', 'Authentication']) {
      const baseline = executeFind(buildGraph(false), query);
      const withSignals = executeFind(buildGraph(true), query);
      expect(withSignals).toEqual(baseline);
    }
  });
});

/**
 * Unit Tests: serve-time background embed (P1.5 slice C)
 *
 * Locks the PURE staleness decision (shouldServeEmbed) and the config surface
 * (serveEmbed default true, INIT_TEMPLATE, --no-serve-embed threaded via
 * mergeWithCLI). The detached spawn + fs.watch live-swap are integration glue,
 * verified by inspection — see the slice C report.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldServeEmbed, countEmbeddable } from '../../src/cli/commands.js';
import { loadConfig, mergeWithCLI, initConfig } from '../../src/config/config.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';

// ─── shouldServeEmbed (the 4 cases) ──────────────────────────────

describe('shouldServeEmbed', () => {
  it('absent embeddings (size null) → true', () => {
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: null, embeddableCount: 10 })).toBe(true);
  });

  it('incomplete embeddings (size < count) → true', () => {
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: 4, embeddableCount: 10 })).toBe(true);
  });

  it('complete embeddings (size >= count) → false', () => {
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: 10, embeddableCount: 10 })).toBe(false);
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: 12, embeddableCount: 10 })).toBe(false);
  });

  it('serveEmbed disabled → false regardless of staleness', () => {
    expect(shouldServeEmbed({ serveEmbed: false, vectorStoreSize: null, embeddableCount: 10 })).toBe(false);
    expect(shouldServeEmbed({ serveEmbed: false, vectorStoreSize: 0, embeddableCount: 10 })).toBe(false);
  });
});

// ─── countEmbeddable: matches the embed predicate (shouldEmbed, NOT isEmbeddable) ──
// The staleness signal must count what embedGraph actually embeds. isEmbeddable
// over-counts binary Source nodes (filename, no body) that embedGraph skips → on any
// binary-bearing corpus the count never reaches the store size and serve re-spawns an
// embed child every time. Lock the predicate alignment here.

describe('countEmbeddable', () => {
  const mk = (id: string, type: NodeType, file: string) => ({
    id, type, name: id, file, startLine: 1, endLine: 1,
    language: Language.Markdown, package: 'p', exported: false,
  });

  it('counts Page/Section/code + a text-native Source(body), EXCLUDES a binary Source(no body)', () => {
    const g = new KnowledgeGraph();
    g.addNode(mk('md:page:a', NodeType.Page, 'a.md'));
    g.addNode(mk('md:sec:a#h', NodeType.Section, 'a.md'));
    g.addNode({ ...mk('ts:fn:f', NodeType.Function, 'f.ts'), language: Language.TypeScript, exported: true });
    g.addNode(mk('src:doc.pdf', NodeType.Source, 'doc.pdf'));    // binary, no body → excluded
    g.addNode(mk('src:notes.txt', NodeType.Source, 'notes.txt')); // text-native, body below → counted

    // Only the .txt source has a persisted body; the .pdf has none.
    expect(countEmbeddable(g, { 'src:notes.txt': 'real body text' })).toBe(4); // isEmbeddable would say 5
  });

  it('null searchText → a Source with no body is not counted', () => {
    const g = new KnowledgeGraph();
    g.addNode(mk('md:page:a', NodeType.Page, 'a.md'));
    g.addNode(mk('src:doc.pdf', NodeType.Source, 'doc.pdf'));
    expect(countEmbeddable(g, null)).toBe(1); // only the Page
  });
});

// ─── config: serveEmbed default + INIT_TEMPLATE + CLI opt-out ─────

describe('config serveEmbed', () => {
  it('defaults to true when no config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-serveembed-'));
    try {
      expect(loadConfig(dir).serveEmbed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects an explicit serveEmbed:false in .recon-wrxn.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-serveembed-'));
    try {
      writeFileSync(join(dir, '.recon-wrxn.json'), JSON.stringify({ serveEmbed: false }), 'utf-8');
      expect(loadConfig(dir).serveEmbed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initConfig writes serveEmbed:true into the template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-serveembed-'));
    try {
      expect(initConfig(dir)).toBe(true);
      expect(loadConfig(dir).serveEmbed).toBe(true);
      const raw = JSON.parse(readFileSync(join(dir, '.recon-wrxn.json'), 'utf-8'));
      expect(raw.serveEmbed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeWithCLI serveEmbed opt-out', () => {
  const base = loadConfig(mkdtempSync(join(tmpdir(), 'recon-serveembed-base-')));

  it('--no-serve-embed (serveEmbed:false) overrides to false', () => {
    expect(mergeWithCLI(base, { serveEmbed: false }).serveEmbed).toBe(false);
  });

  it('absent flag (commander default true) leaves config value intact', () => {
    // commander sets serveEmbed:true by default when only --no-serve-embed exists;
    // that benign true must NOT clobber a config-file serveEmbed:false.
    const cfgFalse = { ...base, serveEmbed: false };
    expect(mergeWithCLI(cfgFalse, { serveEmbed: true }).serveEmbed).toBe(false);
    expect(mergeWithCLI(cfgFalse, {}).serveEmbed).toBe(false);
  });

  it('default config (true) stays true when not opted out', () => {
    expect(mergeWithCLI(base, { serveEmbed: true }).serveEmbed).toBe(true);
    expect(mergeWithCLI(base, {}).serveEmbed).toBe(true);
  });
});

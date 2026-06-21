/**
 * Incremental carry-over (BL-037).
 *
 * Covers the two halves of the fix for "plain `recon index` empties an
 * all-tree-sitter graph":
 *   1. carryOverUnchangedTreeSitter — the pure graph merge (no ghost nodes, no
 *      dangling rels, deleted/parse-failed files dropped, unchanged files kept).
 *   2. analyzeTreeSitter / analyzeTreeSitterParallel — fileHashes is recorded only
 *      after a successful extraction (a parse failure leaves no stale hash → the
 *      file is retried, not silently skipped forever), and analyzedFiles is reported
 *      for both the sequential and worker-pool paths.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const RECON_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/recon-wrxn');
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import {
  carryOverUnchangedTreeSitter,
  pruneDegenerateHashes,
  shouldReactiveHeal,
} from '../../src/analyzers/tree-sitter/carryover.js';

// ─── Helpers ────────────────────────────────────────────────────

function mkNode(partial: Partial<Node> & { id: string; file: string }): Node {
  return {
    type: NodeType.Function,
    name: partial.id,
    startLine: 1,
    endLine: 2,
    language: Language.Python,
    package: '',
    exported: false,
    ...partial,
  };
}

function mkRel(id: string, sourceId: string, targetId: string): Relationship {
  return { id, type: RelationshipType.CALLS, sourceId, targetId, confidence: 1.0 };
}

// ─── Pure merge logic ───────────────────────────────────────────

describe('carryOverUnchangedTreeSitter', () => {
  const langs = [Language.Python, Language.JavaScript];

  it('carries forward an unchanged file’s previous nodes', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:a.py:foo:1', file: 'a.py' }));

    const fresh = new KnowledgeGraph();
    // a.py was skipped (unchanged) → present in hashes, NOT in analyzedFiles.
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'a.py': 'h1' });

    expect(fresh.getNode('py:func:a.py:foo:1')).toBeDefined();
  });

  it('does NOT carry a re-analyzed file’s previous nodes (no stale duplicates)', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:a.py:foo:1', file: 'a.py' })); // old id (old line)

    const fresh = new KnowledgeGraph();
    fresh.addNode(mkNode({ id: 'py:func:a.py:foo:5', file: 'a.py' })); // fresh node, new line

    carryOverUnchangedTreeSitter(fresh, prev, langs, ['a.py'], { 'a.py': 'h2' });

    expect(fresh.getNode('py:func:a.py:foo:5')).toBeDefined(); // fresh kept
    expect(fresh.getNode('py:func:a.py:foo:1')).toBeUndefined(); // stale NOT carried
    expect(fresh.nodeCount).toBe(1);
  });

  it('drops a deleted file’s nodes (absent from new fileHashes)', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:gone.py:foo:1', file: 'gone.py' }));

    const fresh = new KnowledgeGraph();
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'a.py': 'h1' }); // gone.py absent

    expect(fresh.getNode('py:func:gone.py:foo:1')).toBeUndefined();
    expect(fresh.nodeCount).toBe(0);
  });

  it('drops a parse-failed file’s nodes (absent from new fileHashes, not analyzed)', () => {
    // Bug-B contract: a file that failed to parse this run is absent from fileHashes
    // (and from analyzedFiles), so its previous nodes are NOT carried — they would be
    // stale, and the file will be retried next run.
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:boom.py:foo:1', file: 'boom.py' }));

    const fresh = new KnowledgeGraph();
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'a.py': 'h1' }); // boom.py absent

    expect(fresh.getNode('py:func:boom.py:foo:1')).toBeUndefined();
  });

  it('does NOT carry non-tree-sitter (TypeScript) nodes', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'ts:func:x.ts:foo:1', file: 'x.ts', language: Language.TypeScript }));

    const fresh = new KnowledgeGraph();
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'x.ts': 'h1' });

    expect(fresh.getNode('ts:func:x.ts:foo:1')).toBeUndefined();
  });

  it('carries a relationship only when BOTH endpoints survive (AND semantics)', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'A', file: 'a.py' }));
    prev.addNode(mkNode({ id: 'B', file: 'b.py' }));
    prev.addRelationship(mkRel('A-CALLS-B', 'A', 'B'));

    const fresh = new KnowledgeGraph();
    // a.py unchanged, b.py unchanged → both carried → rel survives.
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'a.py': 'h', 'b.py': 'h' });

    expect(fresh.getRelationship('A-CALLS-B')).toBeDefined();
    expect(fresh.getNode('A')).toBeDefined();
    expect(fresh.getNode('B')).toBeDefined();
  });

  it('drops a relationship whose endpoint was on a deleted file (no dangling edge)', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'A', file: 'a.py' }));
    prev.addNode(mkNode({ id: 'B', file: 'gone.py' }));
    prev.addRelationship(mkRel('A-CALLS-B', 'A', 'B'));

    const fresh = new KnowledgeGraph();
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'a.py': 'h' }); // gone.py deleted

    expect(fresh.getNode('A')).toBeDefined();
    expect(fresh.getNode('B')).toBeUndefined();
    expect(fresh.getRelationship('A-CALLS-B')).toBeUndefined(); // no dangling rel
  });

  it('unchanged caller→changed callee: rel survives iff the callee id is unchanged', () => {
    // The callee's file (b.py) is re-analyzed. If the callee keeps the same id (same
    // line), the previous rel's target resolves → carried. The caller (a.py) is unchanged.
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'A', file: 'a.py' }));
    prev.addNode(mkNode({ id: 'B', file: 'b.py' }));
    prev.addRelationship(mkRel('A-CALLS-B', 'A', 'B'));

    // case 1: callee re-emitted with SAME id → rel kept
    const fresh1 = new KnowledgeGraph();
    fresh1.addNode(mkNode({ id: 'B', file: 'b.py' })); // fresh B, same id
    carryOverUnchangedTreeSitter(fresh1, prev, langs, ['b.py'], { 'a.py': 'h', 'b.py': 'h2' });
    expect(fresh1.getNode('A')).toBeDefined(); // unchanged caller carried
    expect(fresh1.getRelationship('A-CALLS-B')).toBeDefined();

    // case 2: callee re-keyed (line shifted) → old target gone → rel dropped, no ghost
    const fresh2 = new KnowledgeGraph();
    fresh2.addNode(mkNode({ id: 'B2', file: 'b.py' })); // fresh B under a new id
    carryOverUnchangedTreeSitter(fresh2, prev, langs, ['b.py'], { 'a.py': 'h', 'b.py': 'h2' });
    expect(fresh2.getNode('A')).toBeDefined();
    expect(fresh2.getRelationship('A-CALLS-B')).toBeUndefined(); // dangling rel dropped
  });

  it('never overwrites a fresh node already present (idempotent)', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'A', file: 'a.py', name: 'OLD' }));

    const fresh = new KnowledgeGraph();
    fresh.addNode(mkNode({ id: 'A', file: 'a.py', name: 'NEW' }));
    // a.py NOT in analyzedFiles but the fresh graph already has id A → keep fresh.
    carryOverUnchangedTreeSitter(fresh, prev, langs, [], { 'a.py': 'h' });

    expect(fresh.getNode('A')?.name).toBe('NEW');
  });
});

// ─── Preventive carry-over: drop degenerate-file hashes (per-file) ──

describe('pruneDegenerateHashes', () => {
  const langs = [Language.Python, Language.JavaScript];

  it('drops the hash of an unchanged code file whose previous graph holds zero symbols', () => {
    // a.py was recorded as "seen" (hash present) but the previous graph has no symbols
    // for it — a partially-degenerate carry-over. Its hash must be dropped so the next
    // analyzer pass treats it as changed and RE-PARSES it instead of carrying it empty.
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:b.py:foo:1', file: 'b.py' })); // b.py has symbols

    const pruned = pruneDegenerateHashes({ 'a.py': 'h1', 'b.py': 'h2' }, prev, langs);

    expect(pruned['a.py']).toBeUndefined(); // empty-in-prev → re-parse
    expect(pruned['b.py']).toBe('h2'); // has symbols → still carryable
  });

  it('keeps every hash when the previous graph holds symbols for all code files', () => {
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:a.py:foo:1', file: 'a.py' }));
    prev.addNode(mkNode({ id: 'py:func:b.py:bar:1', file: 'b.py' }));

    const pruned = pruneDegenerateHashes({ 'a.py': 'h1', 'b.py': 'h2' }, prev, langs);

    expect(pruned).toEqual({ 'a.py': 'h1', 'b.py': 'h2' }); // healthy → unchanged
  });

  it('does NOT drop a non-code (markdown/prose) hash — only tree-sitter files are repaired', () => {
    // Prose/markdown files are not tree-sitter symbols; their absence from the code graph
    // is normal and must not force a re-parse on the tree-sitter walk.
    const prev = new KnowledgeGraph();
    prev.addNode(mkNode({ id: 'py:func:a.py:foo:1', file: 'a.py' }));

    const pruned = pruneDegenerateHashes(
      { 'a.py': 'h1', 'docs/readme.md': 'h2' },
      prev,
      langs,
    );

    expect(pruned['a.py']).toBe('h1');
    expect(pruned['docs/readme.md']).toBe('h2'); // not a code file → untouched
  });

  it('does not mutate the input hashes object (returns a fresh map)', () => {
    const prev = new KnowledgeGraph();
    const input = { 'a.py': 'h1' };

    const pruned = pruneDegenerateHashes(input, prev, langs);

    expect(input).toEqual({ 'a.py': 'h1' }); // caller's object untouched
    expect(pruned).not.toBe(input);
  });
});

// ─── Reactive recovery: the heal decision (pure, no walk) ───────────

describe('shouldReactiveHeal', () => {
  // Detection from existing index stats (parsed + skipped) + final graph symbol count.
  // codeFilesDiscovered = parsed + skipped; heal only when the final graph is empty of
  // code symbols AND code files exist AND the run was incremental AND it has not healed yet.

  it('heals when the run is incremental, code files exist, and the final graph has zero symbols', () => {
    expect(
      shouldReactiveHeal({
        finalSymbols: 0,
        parsed: 0,
        skipped: 5,
        incremental: true,
        alreadyHealed: false,
      }),
    ).toBe(true);
  });

  it('does NOT heal when the final graph already has code symbols', () => {
    expect(
      shouldReactiveHeal({
        finalSymbols: 7,
        parsed: 2,
        skipped: 3,
        incremental: true,
        alreadyHealed: false,
      }),
    ).toBe(false);
  });

  it('does NOT heal a docs-only repo (zero discovered code files)', () => {
    expect(
      shouldReactiveHeal({
        finalSymbols: 0,
        parsed: 0,
        skipped: 0,
        incremental: true,
        alreadyHealed: false,
      }),
    ).toBe(false);
  });

  it('does NOT heal a forced (non-incremental) run — force is already the full path', () => {
    expect(
      shouldReactiveHeal({
        finalSymbols: 0,
        parsed: 0,
        skipped: 5,
        incremental: false,
        alreadyHealed: false,
      }),
    ).toBe(false);
  });

  it('does NOT heal twice — once a run has healed, a still-zero result is accepted', () => {
    expect(
      shouldReactiveHeal({
        finalSymbols: 0,
        parsed: 5,
        skipped: 0,
        incremental: true,
        alreadyHealed: true,
      }),
    ).toBe(false);
  });
});

// ─── Analyzer fileHashes / analyzedFiles (filesystem) ───────────

describe('analyzeTreeSitter incremental — fileHashes & analyzedFiles', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture(fileCount: number): string {
    const root = mkdtempSync(join(tmpdir(), 'recon-incr-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(
        join(root, 'src', `mod${i}.py`),
        `def fn${i}(x):\n    return x + ${i}\n`,
      );
    }
    return root;
  }

  it('first index records every file; second index skips unchanged, re-analyzes changed, drops deleted', async () => {
    const { analyzeTreeSitter } = await import('../../src/analyzers/tree-sitter/analyzer.js');
    const root = fixture(6);

    const run1 = analyzeTreeSitter(root);
    expect(Object.keys(run1.fileHashes)).toHaveLength(6);
    expect(run1.analyzedFiles).toHaveLength(6);
    expect(run1.stats.skipped).toBe(0);

    // change mod0, delete mod1, add mod6 (rename = delete+add)
    writeFileSync(join(root, 'src', 'mod0.py'), `def fn0(x):\n    return x * 100\n`);
    rmSync(join(root, 'src', 'mod1.py'));
    writeFileSync(join(root, 'src', 'mod6.py'), `def fn6(x):\n    return x - 6\n`);

    const run2 = analyzeTreeSitter(root, run1.fileHashes);
    // 4 unchanged (mod2..mod5), mod1 deleted (not walked)
    expect(run2.stats.skipped).toBe(4);
    expect(new Set(run2.analyzedFiles)).toEqual(new Set(['src/mod0.py', 'src/mod6.py']));
    // deleted file is gone from the new hashes; changed + added present; unchanged present
    expect(run2.fileHashes['src/mod1.py']).toBeUndefined();
    expect(run2.fileHashes['src/mod0.py']).toBeDefined();
    expect(run2.fileHashes['src/mod6.py']).toBeDefined();
    expect(run2.fileHashes['src/mod2.py']).toBe(run1.fileHashes['src/mod2.py']);
  });

  it('CLI plain incremental over the worker path carries unchanged nodes instead of emptying the graph', () => {
    // End-to-end reproduction of the BL-037 bug across the worker-pool path (>100 files):
    // a plain `recon index` (no --force, no changes) used to collapse an all-tree-sitter
    // graph to 0 nodes; with the carry-over it must preserve every node. Run as a real
    // subprocess — worker_threads nested inside vitest's own worker pool hangs, but a
    // fresh node process runs the same worker path in ~1s.
    const root = fixture(120);
    const reconNodeCount = (): number =>
      JSON.parse(readFileSync(join(root, '.recon-wrxn/graph.json'), 'utf-8')).nodes.length;
    const index = (args: string[]) =>
      execFileSync('node', [RECON_BIN, 'index', ...args, '--no-embeddings'], {
        cwd: root, stdio: 'pipe',
      });

    index(['--force']);                 // seed (worker path: 120 files)
    const seeded = reconNodeCount();
    expect(seeded).toBe(120);

    index([]);                          // plain incremental, no changes → must NOT empty
    expect(reconNodeCount()).toBe(seeded);

    // change one file (+1 symbol), delete another (-1) → net unchanged count, fresh + dropped
    writeFileSync(join(root, 'src', 'mod0.py'), `def fn0(x):\n    return x * 999\ndef extra0(y):\n    return y\n`);
    rmSync(join(root, 'src', 'mod1.py'));
    index([]);
    const g = JSON.parse(readFileSync(join(root, '.recon-wrxn/graph.json'), 'utf-8'));
    const names = new Set(g.nodes.map((n: { name: string }) => n.name));
    expect(names.has('extra0')).toBe(true);  // changed file re-analyzed → fresh symbol
    expect(names.has('fn1')).toBe(false);     // deleted file → node dropped (no ghost)
    expect(names.has('fn5')).toBe(true);      // unchanged file → carried forward
    expect(g.nodes.length).toBe(120);         // 119 files + mod0's extra symbol
  }, 60_000);

  it('a parse FAILURE leaves no hash → the file is retried, never silently skipped (Bug B)', async () => {
    // Force extractFromFile to throw for one file; the rest extract normally.
    // resetModules first so the (already-imported-by-earlier-tests) analyzer module is
    // re-evaluated against the mocked extractor.
    vi.resetModules();
    vi.doMock('../../src/analyzers/tree-sitter/extractor.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/analyzers/tree-sitter/extractor.js')>();
      return {
        ...actual,
        extractFromFile: (filePath: string, content: string, language: Language) => {
          if (filePath.endsWith('mod2.py')) throw new Error('synthetic parse failure');
          return actual.extractFromFile(filePath, content, language);
        },
      };
    });
    const { analyzeTreeSitter } = await import('../../src/analyzers/tree-sitter/analyzer.js');
    const root = fixture(4); // < 100 → sequential path, so the in-process mock applies

    const run1 = analyzeTreeSitter(root);
    // mod2 threw → absent from hashes + analyzedFiles, present in warnings
    expect(run1.fileHashes['src/mod2.py']).toBeUndefined();
    expect(run1.analyzedFiles).not.toContain('src/mod2.py');
    expect(run1.warnings.some(w => w.file === 'src/mod2.py')).toBe(true);

    // Next run with the previous hashes: mod2 has no recorded hash → NOT skipped → retried.
    const run2 = analyzeTreeSitter(root, run1.fileHashes);
    expect(run2.warnings.some(w => w.file === 'src/mod2.py')).toBe(true); // attempted again
    vi.doUnmock('../../src/analyzers/tree-sitter/extractor.js');
  });
});

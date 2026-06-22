/**
 * Unit Tests: Source index ingestion — walker, graph integration, findability.
 *
 * Covers the path `recon index` uses for multi-format sources (multiformat-
 * distill-01): findSourceFiles (own walker) → analyzeSource → graph + searchText
 * snapshot, and that a text-native Source node is returned by lexical search
 * (BM25) on its body content. Temp-dir fixtures, mirroring markdown-index.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findSourceFiles, analyzeSource } from '../../src/analyzers/source.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { BM25Index } from '../../src/search/bm25.js';
import { NodeType } from '../../src/graph/types.js';

const RECON_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/recon-wrxn');

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recon-src-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'page.html'),
    '<html><body><h1>Quantum Computing</h1><p>Qubits and superposition.</p></body></html>',
  );
  writeFileSync(join(root, 'notes.txt'), 'Plain note about photosynthesis.\n');
  writeFileSync(join(root, 'docs', 'study.pdf'), '%PDF-1.4 binary bytes here');
  writeFileSync(join(root, 'report.docx'), 'PK\x03\x04 zip bytes');
  writeFileSync(join(root, 'node_modules', 'pkg', 'dep.html'), '<p>ignored dep</p>');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findSourceFiles', () => {
  it('finds html/txt/pdf/docx and skips node_modules', () => {
    const files = findSourceFiles(root);
    expect(files.map((f) => f.path).sort()).toEqual([
      'docs/page.html',
      'docs/study.pdf',
      'notes.txt',
      'report.docx',
    ]);
    expect(files.some((f) => f.path.includes('node_modules'))).toBe(false);
  });

  it('reads text-native content but NOT binary bytes', () => {
    const files = findSourceFiles(root);
    const html = files.find((f) => f.path === 'docs/page.html')!;
    const pdf = files.find((f) => f.path === 'docs/study.pdf')!;
    expect(html.kind).toBe('text');
    expect(html.content).toContain('Quantum Computing');
    expect(pdf.kind).toBe('binary');
    expect(pdf.content).toBeUndefined();
  });

  it('respects path-prefix ignore patterns', () => {
    const files = findSourceFiles(root, ['docs']);
    expect(files.map((f) => f.path).sort()).toEqual(['notes.txt', 'report.docx']);
  });
});

describe('Source ingestion → BM25 findability', () => {
  it('a .html Source node is returned by lexical search on its stripped text content', () => {
    const result = analyzeSource(findSourceFiles(root));
    const graph = new KnowledgeGraph();
    for (const n of result.nodes) graph.addNode(n);

    const bm25 = BM25Index.buildFromGraph(graph, result.searchText);
    const hits = bm25.search('quantum superposition').map((h) => h.nodeId);
    expect(hits).toContain('source:docs/page.html');

    // all Source nodes present in the graph, including the minimal binary ones
    const sources = [...graph.nodes.values()].filter((n) => n.type === NodeType.Source);
    expect(sources.map((n) => n.id).sort()).toEqual([
      'source:docs/page.html',
      'source:docs/study.pdf',
      'source:notes.txt',
      'source:report.docx',
    ]);
  });

  it('a .txt Source node is findable by its body', () => {
    const result = analyzeSource(findSourceFiles(root));
    const graph = new KnowledgeGraph();
    for (const n of result.nodes) graph.addNode(n);
    const bm25 = BM25Index.buildFromGraph(graph, result.searchText);
    expect(bm25.search('photosynthesis').map((h) => h.nodeId)).toContain('source:notes.txt');
  });
});

// ─── Self-heal of a degenerate code graph (C1, [#8]) ────────────────
//
// Regression for the sticky-empty bug: an index left with file hashes recorded
// but zero tree-sitter symbols stays empty forever, because every plain `recon
// index` skips the unchanged files and carries from the already-empty previous
// graph. Driven through the REAL `index` CLI over fixture dirs (the subprocess
// pattern from incremental-carryover.test.ts — worker_threads inside vitest's
// own pool hangs, a fresh node process runs the same path in ~1s). The fixtures
// stay under the worker threshold (sequential path) for speed.

describe('index self-heal: degenerate code graph recovers ([#8])', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture(fileCount: number): string {
    const root = mkdtempSync(join(tmpdir(), 'recon-heal-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(join(root, 'src', `mod${i}.py`), `def fn${i}(x):\n    return x + ${i}\n`);
    }
    return root;
  }

  const reconDir = (root: string) => join(root, '.recon-wrxn');
  const readGraph = (root: string) =>
    JSON.parse(readFileSync(join(reconDir(root), 'graph.json'), 'utf-8'));
  const readMeta = (root: string) =>
    JSON.parse(readFileSync(join(reconDir(root), 'meta.json'), 'utf-8'));
  const writeGraph = (root: string, g: unknown) =>
    writeFileSync(join(reconDir(root), 'graph.json'), JSON.stringify(g, null, 2));

  const pySymbolCount = (root: string): number =>
    readGraph(root).nodes.filter((n: { language: string }) => n.language === 'python').length;

  const index = (root: string, args: string[] = []) =>
    execFileSync('node', [RECON_BIN, 'index', ...args, '--no-embeddings'], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

  /**
   * Seed a degenerate index = the exact live failure: real file hashes recorded in
   * meta.json, but the persisted graph stripped of (some or all) tree-sitter symbols.
   * Built by seeding a correct `--force` index, then surgically removing python nodes
   * from graph.json while leaving meta.fileHashes intact.
   *
   * @param keepFiles  python source files (project-relative) whose symbols are RETAINED;
   *                   omitted files become degenerate (hash present, no symbols). Empty
   *                   = total sticky-empty.
   */
  function seedDegenerate(root: string, keepFiles: string[] = []): void {
    index(root, ['--force']); // correct seed
    const keep = new Set(keepFiles);
    const g = readGraph(root);
    g.nodes = g.nodes.filter(
      (n: { language: string; file: string }) => n.language !== 'python' || keep.has(n.file),
    );
    const keptIds = new Set(g.nodes.map((n: { id: string }) => n.id));
    g.relationships = (g.relationships ?? []).filter(
      (r: { sourceId: string; targetId: string }) =>
        keptIds.has(r.sourceId) && keptIds.has(r.targetId),
    );
    writeGraph(root, g); // meta.json (with fileHashes) left intact → degenerate
  }

  it('plain index over a totally-degenerate index (hashes present, zero symbols) recovers symbols > 0', () => {
    const root = fixture(5);
    seedDegenerate(root, []); // strip ALL python symbols, keep all hashes
    expect(pySymbolCount(root)).toBe(0); // precondition: sticky-empty
    expect(Object.keys(readMeta(root).fileHashes).length).toBeGreaterThan(0); // hashes recorded

    index(root, []); // plain incremental — must self-heal, not stay empty

    expect(pySymbolCount(root)).toBeGreaterThan(0);
  }, 60_000);

  it('partial degradation is repaired per-file: empty-in-prev files re-parse, populated ones are untouched', () => {
    const root = fixture(4);
    // Keep mod0+mod1 symbols, strip mod2+mod3 → partial-degradation state.
    seedDegenerate(root, ['src/mod0.py', 'src/mod1.py']);
    const before = readGraph(root).nodes.map((n: { name: string }) => n.name);
    expect(before).toContain('fn0'); // populated survivor
    expect(before).not.toContain('fn2'); // degenerate hole
    expect(before).not.toContain('fn3');

    index(root, []); // plain incremental — must repair the holes

    const after = new Set(readGraph(root).nodes.map((n: { name: string }) => n.name));
    expect(after.has('fn2')).toBe(true); // re-parsed
    expect(after.has('fn3')).toBe(true); // re-parsed
    expect(after.has('fn0')).toBe(true); // still present
    expect(after.has('fn1')).toBe(true); // still present
  }, 60_000);

  it('a healthy incremental run still skips unchanged files — no full reparse', () => {
    const root = fixture(4);
    index(root, ['--force']); // healthy seed
    const seeded = pySymbolCount(root);
    expect(seeded).toBe(4);

    const out = index(root, []); // plain incremental, no changes, no degeneration

    // Stats line proves the unchanged files were SKIPPED (incremental), not all re-parsed.
    expect(out).toContain('incremental mode');
    expect(pySymbolCount(root)).toBe(seeded); // graph preserved, no loss
  }, 60_000);

  it('a docs-only repo (zero supported code files) stays at zero symbols and never heals', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-heal-docs-'));
    dirs.push(root);
    writeFileSync(join(root, 'README.md'), '# Docs only\n\nNo code here.\n');

    index(root, ['--force']); // seed
    expect(pySymbolCount(root)).toBe(0);

    const out = index(root, []); // plain incremental — must NOT trigger a heal loop

    expect(pySymbolCount(root)).toBe(0);
    expect(out).not.toContain('self-heal'); // no heal attempted on docs-only
  }, 60_000);

  it('a forced full pass that still yields zero symbols with code present logs a warning and does not loop', () => {
    // Simulate a genuine grammar failure: a fixture of files the parser produces no
    // symbols for (empty .py files have no defs → zero symbols even on a full parse).
    // The heal must attempt once, find still-zero-with-code, warn, and accept — not loop.
    const root = mkdtempSync(join(tmpdir(), 'recon-heal-empty-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(root, 'src', `blank${i}.py`), '\n'); // no defs

    seedDegenerateNoForce(root); // hashes present, zero symbols, code files exist

    const out = index(root, []); // plain incremental — heals once, still zero, warns

    expect(pySymbolCount(root)).toBe(0); // genuine grammar/empty case stays zero
    expect(out.toLowerCase()).toContain('warning'); // logged, accepted, not looped
  }, 60_000);

  // Seed a degenerate index for a fixture WITHOUT relying on --force producing symbols
  // (used by the genuine-grammar-failure case where files have no defs): index once so
  // meta.fileHashes is written, then ensure graph.json carries zero python symbols.
  function seedDegenerateNoForce(root: string): void {
    index(root, ['--force']);
    const g = readGraph(root);
    g.nodes = g.nodes.filter((n: { language: string }) => n.language !== 'python');
    writeGraph(root, g);
  }
});

/**
 * Unit Tests: live `.md` surgical update in the watcher.
 *
 * The watcher used to gate `.md` out (only tree-sitter code extensions were
 * watchable). This pins the prose path: on a `.md` add/change/unlink the
 * watcher reparses THAT ONE file with the slice-01 analyzer, mutates the shared
 * in-memory graph, and keeps the search-text.json snapshot in lock-step — never
 * touching other files' nodes or snapshot entries.
 *
 * The core surgical entry point is the watcher's `processFile(abs, repo, event)`
 * (chokidar → debounce → enqueue → processFile). chokidar's file-watching and
 * the debounce timer are its own concern (and untestable deterministically), so
 * these drive `processFile` directly with synthetic events — the same seam every
 * real event funnels through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReconWatcher } from '../../src/watcher/watcher.js';
import { analyzeMarkdown, findMarkdownFiles } from '../../src/analyzers/markdown.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { saveSearchText, loadSearchText } from '../../src/storage/store.js';
import { NodeType } from '../../src/graph/types.js';

const A_ORIGINAL = '# Alpha\nAlpha body original.\n\n## Section One\nSection one body.\n';
const A_UPDATED = '# Alpha\nAlpha body UPDATED.\n\n## Section Two\nBrand new section.\n';
const B_FIXED = '# Beta\nBeta body.\n\n## Beta Section\nBeta section body.\n';

let root: string;
let graph: KnowledgeGraph;
let watcher: ReconWatcher;

/** Drive the watcher's core surgical update for one file event. */
function fire(rel: string, event: 'add' | 'change' | 'unlink'): Promise<void> {
  // processFile is the documented "core surgical update" entry; cast past the
  // private modifier to reach it without chokidar/debounce timing.
  return (watcher as unknown as {
    processFile(abs: string, repo: string, event: string): Promise<void>;
  }).processFile(join(root, rel), 'proj', event);
}

const nodesOf = (file: string) => [...graph.nodes.values()].filter((n) => n.file === file);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'recon-wmd-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.md'), A_ORIGINAL);
  writeFileSync(join(root, 'docs', 'b.md'), B_FIXED);

  // Build the initial indexed state the way `recon index` does: analyze the
  // corpus into the graph + persist the search-text.json snapshot.
  const result = analyzeMarkdown(findMarkdownFiles(root));
  graph = new KnowledgeGraph();
  for (const n of result.nodes) graph.addNode(n);
  for (const r of result.relationships) graph.addRelationship(r);
  await saveSearchText(root, result.searchText);

  watcher = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, [], root);
});

afterEach(() => {
  watcher.stop(); // clears the auto-save timer so vitest doesn't hang
  rmSync(root, { recursive: true, force: true });
});

describe('watcher .md change — surgical, file-scoped', () => {
  it('updates exactly the changed file\'s prose nodes; others untouched', async () => {
    const bBefore = nodesOf('docs/b.md').map((n) => n.id).sort();

    writeFileSync(join(root, 'docs', 'a.md'), A_UPDATED);
    await fire('docs/a.md', 'change');

    // a.md: old section gone, new section in, page still present.
    const aNames = nodesOf('docs/a.md').filter((n) => n.type === NodeType.Section).map((n) => n.name);
    expect(aNames).toContain('Section Two');
    expect(aNames).not.toContain('Section One');
    expect(graph.getNode('md:page:docs/a.md')).toBeDefined();

    // b.md: byte-identical node id set.
    expect(nodesOf('docs/b.md').map((n) => n.id).sort()).toEqual(bBefore);
  });

  it('keeps the search-text.json snapshot consistent for the changed file', async () => {
    const before = (await loadSearchText(root))!;
    const bKeys = Object.keys(before).filter((k) => k.includes('docs/b.md'));

    writeFileSync(join(root, 'docs', 'a.md'), A_UPDATED);
    await fire('docs/a.md', 'change');

    const after = (await loadSearchText(root))!;

    // a.md page entry reflects the new body; the removed section's text is gone.
    expect(after['md:page:docs/a.md']).toContain('Brand new section.');
    expect(after['md:page:docs/a.md']).not.toContain('Section one body.');
    expect(Object.values(after).some((v) => v.includes('Section one body.'))).toBe(false);

    // every b.md entry is preserved byte-for-byte.
    for (const k of bKeys) expect(after[k]).toBe(before[k]);
  });
});

describe('watcher .md add', () => {
  it('ingests a brand-new .md into the graph and the snapshot', async () => {
    writeFileSync(join(root, 'docs', 'c.md'), '# Gamma\nGamma body.\n');
    await fire('docs/c.md', 'add');

    expect(graph.getNode('md:page:docs/c.md')).toBeDefined();
    const after = (await loadSearchText(root))!;
    expect(after['md:page:docs/c.md']).toContain('Gamma body.');
    // existing files untouched.
    expect(graph.getNode('md:page:docs/a.md')).toBeDefined();
    expect(after['md:page:docs/b.md']).toBeDefined();
  });
});

describe('watcher .md size cap', () => {
  // multiformat-distill-04: the live markdown surgical path must honor a
  // configured maxFileSize too (the source path already does). By default (the
  // watcher built in beforeEach with no cap) a >1 MB .md is INDEXED.
  it('indexes a >1 MB .md by default (no cap)', async () => {
    const big = '# Huge\n\n' + 'word '.repeat(250_000); // > 1 MB
    writeFileSync(join(root, 'docs', 'huge.md'), big);
    await fire('docs/huge.md', 'add');

    expect(graph.getNode('md:page:docs/huge.md')).toBeDefined();
    const after = (await loadSearchText(root))!;
    expect(after['md:page:docs/huge.md']).toBeDefined();
  });

  it('skips a .md over maxFileSize when the install configures one', async () => {
    // A watcher built with a finite cap skips a markdown file above it.
    const capped = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, [], root, 500_000);
    const fireCapped = (rel: string, event: string) =>
      (capped as unknown as {
        processFile(abs: string, repo: string, event: string): Promise<void>;
      }).processFile(join(root, rel), 'proj', event);

    const big = '# Huge2\n\n' + 'word '.repeat(250_000); // > 500 KB cap
    writeFileSync(join(root, 'docs', 'huge2.md'), big);
    await fireCapped('docs/huge2.md', 'add');
    capped.stop();

    expect(graph.getNode('md:page:docs/huge2.md')).toBeUndefined();
    const after = (await loadSearchText(root))!;
    expect(after['md:page:docs/huge2.md']).toBeUndefined();
    // a normal file beside it is untouched
    expect(after['md:page:docs/b.md']).toBeDefined();
  });
});

describe('watcher .md unlink', () => {
  it('removes the file\'s prose nodes AND snapshot entries; others survive', async () => {
    const aKeys = Object.keys((await loadSearchText(root))!).filter((k) => k.includes('docs/a.md'));
    expect(aKeys.length).toBeGreaterThan(0);

    await fire('docs/a.md', 'unlink');

    expect(nodesOf('docs/a.md')).toHaveLength(0);
    const after = (await loadSearchText(root))!;
    for (const k of aKeys) expect(after[k]).toBeUndefined();
    // b.md still fully present.
    expect(nodesOf('docs/b.md').length).toBeGreaterThan(0);
    expect(after['md:page:docs/b.md']).toBeDefined();
  });
});

describe('watcher non-.md (code) path unaffected', () => {
  it('a .ts change never touches the prose graph or the snapshot', async () => {
    const before = (await loadSearchText(root))!;

    writeFileSync(join(root, 'docs', 'app.ts'), 'export const x = 1;\n');
    await fire('docs/app.ts', 'change');

    // no prose node was created for the code file.
    const proseForTs = nodesOf('docs/app.ts').filter(
      (n) => n.type === NodeType.Page || n.type === NodeType.Section,
    );
    expect(proseForTs).toHaveLength(0);
    // snapshot is byte-identical — the markdown path was never entered.
    expect(await loadSearchText(root)).toEqual(before);
  });
});

describe('watcher .md robustness', () => {
  it('with no projectRoot, still mutates the graph but writes no snapshot', async () => {
    // Graph-only watcher (mirrors persistGraph's no-root guard): the in-memory
    // graph must still go live; only the on-disk snapshot write is skipped.
    const rootless = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, []);
    writeFileSync(join(root, 'docs', 'a.md'), A_UPDATED);
    await (rootless as unknown as {
      processFile(a: string, r: string, e: string): Promise<void>;
    }).processFile(join(root, 'docs', 'a.md'), 'proj', 'change');
    rootless.stop();

    const aNames = nodesOf('docs/a.md').filter((n) => n.type === NodeType.Section).map((n) => n.name);
    expect(aNames).toContain('Section Two'); // graph reparsed
    // snapshot untouched — it still holds the original (pre-change) text.
    const snap = (await loadSearchText(root))!;
    expect(Object.values(snap).some((v) => v.includes('Section one body.'))).toBe(true);
  });

  it('a change event for a file already gone from disk prunes nodes + snapshot (no throw)', async () => {
    const aKeys = Object.keys((await loadSearchText(root))!).filter((k) => k.includes('docs/a.md'));
    rmSync(join(root, 'docs', 'a.md'));

    await fire('docs/a.md', 'change'); // readFileSync throws → graceful prune

    expect(nodesOf('docs/a.md')).toHaveLength(0);
    const after = (await loadSearchText(root))!;
    for (const k of aKeys) expect(after[k]).toBeUndefined();
    expect(nodesOf('docs/b.md').length).toBeGreaterThan(0);
  });
});

describe('watcher .md surgical update latency', () => {
  it('completes well under a full-reindex (spike measured ~38ms)', async () => {
    writeFileSync(join(root, 'docs', 'a.md'), A_UPDATED);
    const t0 = performance.now();
    await fire('docs/a.md', 'change');
    const dt = performance.now() - t0;
    // Smoke guard against an accidental O(whole-corpus) reparse (seconds). The
    // real tens-of-ms figure is the spike's; the file-scoped assertions above
    // are the structural proof that the cost is O(one file).
    expect(dt).toBeLessThan(1000);
  });
});

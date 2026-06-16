/**
 * Unit Tests: live multi-format Source surgical update in the watcher.
 *
 * Pins the multiformat-distill-01 watcher path: on a .html/.txt/.pdf add/change/
 * unlink the watcher reparses THAT ONE file with analyzeSource, mutates the
 * shared in-memory graph, and keeps the search-text.json snapshot in lock-step —
 * never touching other files. Drives processFile directly (the seam every real
 * chokidar event funnels through), as watcher-markdown.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReconWatcher } from '../../src/watcher/watcher.js';
import { analyzeSource, findSourceFiles } from '../../src/analyzers/source.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { saveSearchText, loadSearchText } from '../../src/storage/store.js';
import { NodeType } from '../../src/graph/types.js';
import type { SqliteStore } from '../../src/storage/sqlite.js';

let root: string;
let graph: KnowledgeGraph;
let watcher: ReconWatcher;

function fire(rel: string, event: 'add' | 'change' | 'unlink'): Promise<void> {
  return (watcher as unknown as {
    processFile(abs: string, repo: string, event: string): Promise<void>;
  }).processFile(join(root, rel), 'proj', event);
}

const nodesOf = (file: string) => [...graph.nodes.values()].filter((n) => n.file === file);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'recon-wsrc-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.html'), '<h1>Alpha</h1><p>original body.</p>');
  writeFileSync(join(root, 'docs', 'keep.txt'), 'keep this body.');

  const result = analyzeSource(findSourceFiles(root));
  graph = new KnowledgeGraph();
  for (const n of result.nodes) graph.addNode(n);
  await saveSearchText(root, result.searchText);

  watcher = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, [], root);
});

afterEach(() => {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('watcher .html change — surgical, file-scoped', () => {
  it('reparses the changed Source node and updates its snapshot; others untouched', async () => {
    const keepBefore = (await loadSearchText(root))!['source:docs/keep.txt'];

    writeFileSync(join(root, 'docs', 'a.html'), '<h1>Alpha</h1><p>UPDATED body.</p>');
    await fire('docs/a.html', 'change');

    expect(graph.getNode('source:docs/a.html')).toBeDefined();
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/a.html']).toContain('UPDATED body.');
    expect(after['source:docs/a.html']).not.toContain('original body.');
    // keep.txt preserved byte-for-byte
    expect(after['source:docs/keep.txt']).toBe(keepBefore);
  });
});

describe('watcher Source add', () => {
  it('ingests a brand-new .txt Source node + snapshot entry', async () => {
    writeFileSync(join(root, 'docs', 'new.txt'), 'brand new source body.');
    await fire('docs/new.txt', 'add');

    expect(graph.getNode('source:docs/new.txt')).toBeDefined();
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/new.txt']).toContain('brand new source body.');
  });

  it('ingests a brand-new .json Source node with serialized key+value snapshot', async () => {
    writeFileSync(join(root, 'docs', 'conf.json'), '{"service":"api","port":8080}');
    await fire('docs/conf.json', 'add');

    expect(graph.getNode('source:docs/conf.json')).toBeDefined();
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/conf.json']).toContain('service');
    expect(after['source:docs/conf.json']).toContain('8080');
  });

  it('ingests a binary Source as a minimal node with NO snapshot entry', async () => {
    writeFileSync(join(root, 'docs', 'paper.pdf'), '%PDF-1.4 bytes');
    await fire('docs/paper.pdf', 'add');

    const node = graph.getNode('source:docs/paper.pdf');
    expect(node).toBeDefined();
    expect(node!.type).toBe(NodeType.Source);
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/paper.pdf']).toBeUndefined();
  });
});

describe('watcher Source size cap', () => {
  // multiformat-distill-04: the hard 1 MB cap is gone — by default (the watcher
  // built in beforeEach with no maxFileSize) a >1 MB text-native source is INDEXED.
  it('indexes a >1 MB text-native source by default (no cap)', async () => {
    const big = 'huge ' + 'x'.repeat(1_000_001); // > 1 MB
    writeFileSync(join(root, 'docs', 'huge.txt'), big);
    await fire('docs/huge.txt', 'add');

    expect(graph.getNode('source:docs/huge.txt')).toBeDefined();
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/huge.txt']).toBeDefined();
  });

  it('skips a source over maxFileSize when the install configures one', async () => {
    // A watcher built with a finite cap skips a text-native source above it.
    const capped = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, [], root, 500_000);
    const fireCapped = (rel: string, event: string) =>
      (capped as unknown as {
        processFile(abs: string, repo: string, event: string): Promise<void>;
      }).processFile(join(root, rel), 'proj', event);

    writeFileSync(join(root, 'docs', 'huge2.txt'), 'x'.repeat(1_000_001)); // > 500 KB cap
    await fireCapped('docs/huge2.txt', 'add');
    capped.stop();

    expect(graph.getNode('source:docs/huge2.txt')).toBeUndefined();
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/huge2.txt']).toBeUndefined();
    // a normal file beside it is untouched
    expect(after['source:docs/keep.txt']).toBeDefined();
  });
});

describe('watcher Source unlink', () => {
  it('removes the Source node AND its snapshot entry; others survive', async () => {
    await fire('docs/a.html', 'unlink');

    expect(nodesOf('docs/a.html')).toHaveLength(0);
    const after = (await loadSearchText(root))!;
    expect(after['source:docs/a.html']).toBeUndefined();
    expect(after['source:docs/keep.txt']).toBeDefined();
  });

  it('prunes the SQLite store on a source unlink (slice B fix 1 — symmetric)', async () => {
    // The source unlink branch used to return BEFORE the SQLite persist block,
    // leaving deleted nodes in SQLite. It must now call removeNodesByFile.
    const removed: string[] = [];
    const store = {
      removeNodesByFile: (f: string) => { removed.push(f); return 0; },
      insertNodes: () => {},
      insertRelationships: () => {},
    } as unknown as SqliteStore;
    const w = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, [], root, Infinity, store);
    await (w as unknown as { processFile(a: string, r: string, e: string): Promise<void> })
      .processFile(join(root, 'docs/a.html'), 'proj', 'unlink');
    w.stop();
    expect(removed).toContain('docs/a.html');
  });
});

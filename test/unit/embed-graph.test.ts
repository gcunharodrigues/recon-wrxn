/**
 * Unit Tests: embedGraph + index --embeddings-only (P1.5 slice C, PART 1)
 *
 * The embed pass is factored out of indexCommand into embedGraph (reused by both
 * the full index and the embed-only path). The embed-only path embeds a STORED
 * index without re-walking and without rewriting graph.json — the load-bearing
 * invariant (serve's watcher also writes graph.json; the bg embed must not race it).
 *
 * The real transformer model is an optional dependency and slow, so the embedder
 * is injected (EmbedderDeps seam) with a deterministic fake — no model needed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import type { IndexMeta } from '../../src/storage/types.js';
import { saveIndex, saveSearchText, loadEmbeddings } from '../../src/storage/store.js';
import { embedGraph, indexEmbeddingsOnly, type EmbedderDeps } from '../../src/cli/commands.js';
import { DEFAULT_CONFIG } from '../../src/search/embedder.js';

// ─── Fakes ───────────────────────────────────────────────────────

/** A deterministic embedder that needs no model — records what it embedded. */
function fakeEmbedder(): EmbedderDeps & { embedded: string[]; inited: number; disposed: number } {
  const state = { embedded: [] as string[], inited: 0, disposed: 0 };
  return {
    embedded: state.embedded,
    get inited() { return state.inited; },
    get disposed() { return state.disposed; },
    initEmbedder: async () => { state.inited++; },
    embedBatch: async (texts: string[]) => {
      state.embedded.push(...texts);
      return texts.map(() => {
        const v = new Float32Array(DEFAULT_CONFIG.dimensions);
        v[0] = 1; // unit vector — valid for VectorStore.add
        return v;
      });
    },
    disposeEmbedder: async () => { state.disposed++; },
  } as EmbedderDeps & { embedded: string[]; inited: number; disposed: number };
}

function page(file: string, name: string): Node {
  return {
    id: `md:page:${file}`,
    type: NodeType.Page,
    name,
    file,
    startLine: 1,
    endLine: 1,
    language: Language.Markdown,
    package: 'docs',
    exported: false,
  };
}

function meta(fileHashes: Record<string, string>): IndexMeta {
  return {
    version: 1,
    indexedAt: new Date().toISOString(),
    gitCommit: 'abc1234',
    gitBranch: 'main',
    stats: { tsModules: 0, tsSymbols: 0, relationships: 0, indexTimeMs: 1 },
    fileHashes,
  };
}

async function seedIndex(dir: string): Promise<{ graph: KnowledgeGraph; searchText: Record<string, string> }> {
  const graph = new KnowledgeGraph();
  graph.addNode(page('docs/a.md', 'Alpha'));
  graph.addNode(page('docs/b.md', 'Beta'));
  const searchText: Record<string, string> = {
    'md:page:docs/a.md': 'Alpha alpha body about retrieval',
    'md:page:docs/b.md': 'Beta beta body about ranking',
  };
  await saveIndex(dir, graph, meta({ 'docs/a.md': 'ha', 'docs/b.md': 'hb' }));
  await saveSearchText(dir, searchText);
  return { graph, searchText };
}

// ─── embedGraph ──────────────────────────────────────────────────

describe('embedGraph', () => {
  it('writes embeddings.json and never touches graph.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-embedgraph-'));
    try {
      const { graph, searchText } = await seedIndex(dir);
      const graphBefore = readFileSync(join(dir, '.recon-wrxn', 'graph.json'));
      const fake = fakeEmbedder();

      const result = await embedGraph(
        dir, graph, searchText, undefined,
        { previousHashes: undefined, currentHashes: { 'docs/a.md': 'ha', 'docs/b.md': 'hb' } },
        fake,
      );

      // embeddings.json written, both prose nodes embedded
      expect(existsSync(join(dir, '.recon-wrxn', 'embeddings.json'))).toBe(true);
      expect(result?.size).toBe(2);
      expect(fake.embedded.length).toBe(2);
      // graph.json byte-identical — embedGraph must not re-serialize the graph
      expect(readFileSync(join(dir, '.recon-wrxn', 'graph.json'))).toEqual(graphBefore);

      const reloaded = await loadEmbeddings(dir);
      expect(reloaded?.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries over already-embedded unchanged nodes and embeds only the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-embedgraph-'));
    try {
      const { graph, searchText } = await seedIndex(dir);

      // First pass embeds both.
      const fake1 = fakeEmbedder();
      await embedGraph(dir, graph, searchText, undefined,
        { previousHashes: { 'docs/a.md': 'ha', 'docs/b.md': 'hb' }, currentHashes: { 'docs/a.md': 'ha', 'docs/b.md': 'hb' } },
        fake1);
      expect(fake1.embedded.length).toBe(2);

      // Second pass: a.md unchanged (carry over), b.md changed (re-embed).
      const fake2 = fakeEmbedder();
      const result = await embedGraph(dir, graph, searchText, undefined,
        { previousHashes: { 'docs/a.md': 'ha', 'docs/b.md': 'hb' }, currentHashes: { 'docs/a.md': 'ha', 'docs/b.md': 'CHANGED' } },
        fake2);

      expect(fake2.embedded.length).toBe(1); // only b.md re-embedded
      expect(result?.reused).toBe(1);
      expect(result?.embedded).toBe(1);
      expect(result?.size).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null and skips the model when there is nothing embeddable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-embedgraph-'));
    try {
      const graph = new KnowledgeGraph(); // empty → no embeddable nodes
      const fake = fakeEmbedder();
      const result = await embedGraph(dir, graph, {}, undefined,
        { previousHashes: undefined, currentHashes: {} }, fake);
      expect(result).toBeNull();
      expect(fake.inited).toBe(0); // model never loaded
      expect(existsSync(join(dir, '.recon-wrxn', 'embeddings.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── indexEmbeddingsOnly (the embed-only path) ───────────────────

describe('indexEmbeddingsOnly', () => {
  it('embeds a stored index, writing ONLY embeddings.json (graph.json byte-unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-embedonly-'));
    try {
      await seedIndex(dir);
      const graphBefore = readFileSync(join(dir, '.recon-wrxn', 'graph.json'));
      const searchTextBefore = readFileSync(join(dir, '.recon-wrxn', 'search-text.json'));
      const fake = fakeEmbedder();

      await indexEmbeddingsOnly(dir, undefined, fake);

      // embeddings.json produced from the stored graph + searchText
      expect(existsSync(join(dir, '.recon-wrxn', 'embeddings.json'))).toBe(true);
      const reloaded = await loadEmbeddings(dir);
      expect(reloaded?.size).toBe(2);
      // No re-walk, no graph rewrite: graph.json + search-text.json byte-identical
      expect(readFileSync(join(dir, '.recon-wrxn', 'graph.json'))).toEqual(graphBefore);
      expect(readFileSync(join(dir, '.recon-wrxn', 'search-text.json'))).toEqual(searchTextBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a safe no-op when no index exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-embedonly-'));
    try {
      mkdirSync(join(dir, '.recon-wrxn'), { recursive: true });
      const fake = fakeEmbedder();
      await indexEmbeddingsOnly(dir, undefined, fake);
      expect(existsSync(join(dir, '.recon-wrxn', 'embeddings.json'))).toBe(false);
      expect(fake.inited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('embeds under a named repo subdir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-embedonly-'));
    try {
      const repoDir = join(dir, '.recon-wrxn', 'repos', 'svc');
      mkdirSync(repoDir, { recursive: true });
      const graph = new KnowledgeGraph();
      graph.addNode(page('docs/x.md', 'Xeno'));
      await saveIndex(dir, graph, meta({ 'docs/x.md': 'hx' }), 'svc');
      await saveSearchText(dir, { 'md:page:docs/x.md': 'Xeno body' }, 'svc');

      const fake = fakeEmbedder();
      await indexEmbeddingsOnly(dir, 'svc', fake);

      expect(existsSync(join(repoDir, 'embeddings.json'))).toBe(true);
      const reloaded = await loadEmbeddings(dir, 'svc');
      expect(reloaded?.size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

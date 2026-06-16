/**
 * Unit Tests: HTTP find door — live store getter + structured hybrid hits
 * (recon-brain-recall-01)
 *
 * Two coupled behaviors of POST /api/tools/recon_find over the createApp seam:
 *  (1) the door resolves the vector store through the LIVE getter per request, so a
 *      mid-session embedding hot-swap is visible without a restart (the store was
 *      captured BY VALUE at createApp before — the stdio path already uses a getter);
 *  (2) the door returns a STRUCTURED per-hit `hits` array carrying the per-arm signal
 *      (id/type/file/line + cosine semanticScore + arm-provenance sources) that the
 *      find path used to drop at the nodeId map — while the agent-facing markdown
 *      `result` stays byte-identical to the stdio recon_find output.
 *
 * handleFind gates the semantic arm on isEmbedderReady(); the real transformers model
 * can't load under vitest, so the embedder module is mocked to plant a deterministic
 * query embedding (the same fake-embedder strategy as find-hybrid.test.ts, applied at
 * the module seam the handler reads).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { VectorStore } from '../../src/search/vector-store.js';
import { BM25Index } from '../../src/search/bm25.js';
import { setFulltextRanker } from '../../src/mcp/find.js';
import { createApp } from '../../src/server/http.js';
import { handleToolCall } from '../../src/mcp/handlers.js';
import type { Express } from 'express';

// Plant a deterministic query embedding so the HTTP door drives the FULL hybrid path
// (handleFind builds embedQuery only when isEmbedderReady()). 3-dim hot-0 vector.
vi.mock('../../src/search/embedder.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/search/embedder.js')>();
  return {
    ...actual,
    isEmbedderReady: () => true,
    embedText: async (_q: string) => new Float32Array([1, 0, 0]),
  };
});

const QUERY = 'semantic retrieval concept'; // 3 words → classifies fulltext

function page(id: string, name: string, file: string): Node {
  return {
    id, type: NodeType.Page, name, file, startLine: 1, endLine: 1,
    language: Language.Markdown, package: 'docs', exported: false,
  };
}
function code(id: string, name: string, file: string): Node {
  return {
    id, type: NodeType.Function, name, file, startLine: 7, endLine: 12,
    language: Language.TypeScript, package: 'src', exported: true,
  };
}
function vec(hot: number): Float32Array { const v = new Float32Array(3); v[hot] = 1; return v; }

function buildGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  // prose page: body shares the query terms (BM25 hit) AND gets an aligned vector.
  g.addNode(page('md:page:concept.md', 'Concept Page', 'docs/concept.md'));
  // code node: name carries a query term → BM25 hits it (the "code" arm of the fusion).
  g.addNode(code('ts:func:semanticCache', 'semanticCache', 'src/cache.ts'));
  return g;
}

describe('POST /api/tools/recon_find — hybrid over the live store (recon-brain-recall-01)', () => {
  let graph: KnowledgeGraph;
  let store: VectorStore;
  let app: Express;

  beforeEach(() => {
    graph = buildGraph();
    setFulltextRanker(BM25Index.buildFromGraph(graph, {
      'md:page:concept.md': 'semantic retrieval concept body about vectors',
    }));
    store = new VectorStore(3);
    store.add('md:page:concept.md', vec(0), NodeType.Page); // aligned with the planted query
    app = createApp({ port: 0, graph, vectorStore: store });
  });

  afterEach(() => setFulltextRanker(null));

  it('returns code+prose fused results for a query matching both arms', async () => {
    const res = await request(app).post('/api/tools/recon_find').send({ query: QUERY });
    expect(res.status).toBe(200);
    // the agent markdown still carries both the prose page and the code symbol
    expect(res.body.result).toContain('Concept Page');
    expect(res.body.result).toContain('semanticCache');
    // ...and so does the structured hits array
    const files = (res.body.hits as Array<{ file: string }>).map(h => h.file);
    expect(files).toContain('docs/concept.md');
    expect(files).toContain('src/cache.ts');
  });

  it('exposes a structured per-hit array: id, type, file/line, semanticScore, sources', async () => {
    const res = await request(app).post('/api/tools/recon_find').send({ query: QUERY });
    expect(Array.isArray(res.body.hits)).toBe(true);
    const proseHit = (res.body.hits as Array<Record<string, unknown>>)
      .find(h => h.file === 'docs/concept.md')!;
    expect(proseHit.id).toBe('md:page:concept.md');
    expect(proseHit.type).toBe(NodeType.Page);
    expect(typeof proseHit.line).toBe('number');
    // the cosine the node-stdlib consumer (Recall hook) cannot compute itself
    expect(typeof proseHit.semanticScore).toBe('number');
    expect(proseHit.semanticScore as number).toBeGreaterThan(0.9);
    // arm provenance: found by BOTH arms = the consensus signal
    expect(proseHit.sources).toContain('semantic');
    expect(proseHit.sources).toContain('bm25');
  });

  it('reads the store through the LIVE getter: a mid-session swap is seen on the next request', async () => {
    // Start with an EMPTY store (semantic arm off → BM25-only hit, no cosine), then
    // swap in the embedded store. If the door captured the store by value, request 2
    // would still see the empty store and carry no semantic signal.
    let live: VectorStore | null = new VectorStore(3);
    const getter = vi.fn(() => live);
    const liveApp = createApp({ port: 0, graph, vectorStore: getter });

    const res1 = await request(liveApp).post('/api/tools/recon_find').send({ query: QUERY });
    const hit1 = (res1.body.hits as Array<Record<string, unknown>>).find(h => h.file === 'docs/concept.md')!;
    expect(hit1.semanticScore).toBeUndefined(); // empty store → semantic arm absent
    expect(hit1.sources).toBeUndefined();

    live = store; // mid-session embedding hot-swap
    const res2 = await request(liveApp).post('/api/tools/recon_find').send({ query: QUERY });
    const hit2 = (res2.body.hits as Array<Record<string, unknown>>).find(h => h.file === 'docs/concept.md')!;
    expect(hit2.sources).toContain('semantic'); // NEW store read → semantic arm fired
    expect(typeof hit2.semanticScore).toBe('number');
    expect(getter).toHaveBeenCalledTimes(2); // resolved per request, not once at createApp
  });

  it('BM25-only fallback is intact when there is no store (graceful, no throw)', async () => {
    const bm25App = createApp({ port: 0, graph, vectorStore: null });
    const res = await request(bm25App).post('/api/tools/recon_find').send({ query: QUERY });
    expect(res.status).toBe(200);
    const proseHit = (res.body.hits as Array<Record<string, unknown>>).find(h => h.file === 'docs/concept.md');
    expect(proseHit).toBeDefined(); // BM25 still returns the lexical hit
    expect(proseHit!.semanticScore).toBeUndefined(); // no semantic arm without a store
  });

  it('the agent markdown `result` is byte-identical to the stdio recon_find output (regression guard)', async () => {
    const res = await request(app).post('/api/tools/recon_find').send({ query: QUERY });
    const stdio = await handleToolCall('recon_find', { query: QUERY }, graph, undefined, store);
    expect(res.body.result).toBe(stdio); // additive: hits added ALONGSIDE, markdown unchanged
  });
});

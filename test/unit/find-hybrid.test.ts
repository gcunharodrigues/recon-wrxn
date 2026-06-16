/**
 * Unit Tests: hybrid RRF retrieval + interrogative-query classifier fix
 * (recon-prose-analyzer-04)
 *
 * Two behaviors are locked here:
 *  (B) classifyQuery demotes an interrogative-led question with a weak structural
 *      signal (<2 keywords) to fulltext, so a conceptual question that happens to
 *      contain a structural keyword ("…orphan analysis…") still reaches retrieval
 *      instead of being diverted to the structural strategy.
 *  (A) executeFindHybrid fuses BM25 ⊕ node-type-scoped vector results via RRF on
 *      the fulltext path, with a built-in fallback to pure BM25 when the embedding
 *      layer is absent/empty/throwing. Asserted with an INJECTED fake embedder —
 *      transformers.js does not run under vitest, so the embedder is a parameter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import {
  classifyQuery,
  executeFind,
  executeFindHybrid,
  setFulltextRanker,
} from '../../src/mcp/find.js';
import type { QueryStrategy } from '../../src/mcp/find.js';
import { BM25Index } from '../../src/search/bm25.js';
import type { BM25Result } from '../../src/search/bm25.js';
import { VectorStore } from '../../src/search/vector-store.js';
import type { VectorSearchResult } from '../../src/search/vector-store.js';
import { mergeWithRRF } from '../../src/search/hybrid-search.js';

// ─── Fixture builders ────────────────────────────────────────────

function page(id: string, name: string, file: string): Node {
  return {
    id, type: NodeType.Page, name, file,
    startLine: 1, endLine: 1, language: Language.Markdown, package: 'docs', exported: false,
  };
}

function code(id: string, name: string, file: string, overrides?: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name, file,
    startLine: 1, endLine: 5, language: Language.TypeScript, package: 'src', exported: true,
    ...overrides,
  };
}

/** A unit vector with a single hot dimension — a controlled, planted embedding. */
function unitVec(dims: number, hot = 0): Float32Array {
  const v = new Float32Array(dims);
  v[hot] = 1;
  return v;
}

/**
 * A fake query embedder: ignores the query and returns a planted vector. The
 * fusion arm is what we test here, not transformers.js (which can't run in vitest).
 */
const fakeEmbed = (vec: Float32Array) => async (_q: string): Promise<Float32Array> => vec;

// ─── (B) Classifier: interrogative-question demotion ─────────────

describe('classifyQuery — interrogative-question demotion (recon-prose-analyzer-04)', () => {
  it('demotes the gold Q2 "why … orphan analysis …" question to fulltext', () => {
    // Contains the structural keyword "orphan" but is a conceptual question with
    // <2 structural keywords → must reach fulltext, not divert to structural.
    expect(classifyQuery('why is static import and orphan analysis unreliable here'))
      .toBe<QueryStrategy>('fulltext');
  });

  it('demotes "how does the test harness work" to fulltext (contains "test", 1 kw)', () => {
    expect(classifyQuery('how does the test harness work')).toBe<QueryStrategy>('fulltext');
  });

  it('demotes "why is the orphan check unreliable" to fulltext (contains "orphan", 1 kw)', () => {
    expect(classifyQuery('why is the orphan check unreliable')).toBe<QueryStrategy>('fulltext');
  });

  it('KEEPS a 2-keyword question structural ("what are the exported functions with no callers")', () => {
    // The <2 guard preserves a strong structural signal even when phrased as a question.
    expect(classifyQuery('what are the exported functions with no callers'))
      .toBe<QueryStrategy>('structural');
  });

  it('leaves a non-question structural query unchanged ("orphan dead code")', () => {
    expect(classifyQuery('orphan dead code')).toBe<QueryStrategy>('structural');
  });
});

// ─── (B2) Classifier: ?-routing + hard-structural-intent retention (review fixes) ──
// Two follow-on classifier bugs from the -04 review:
//  FIX-2: a multi-word natural-language question ending in '?' was force-classified
//         'pattern' by Rule 1 (any '?'), then matched nothing — the headline
//         conceptual-query use case returned "No results". '?' is now a glob wildcard
//         ONLY for a single whitespace-free token; multi-word '?'-questions fall through.
//  FIX-3: a genuinely-structural question with ONE *hard* keyword (e.g. "no callers")
//         was over-demoted to fulltext, where caller counts can't be computed. The
//         demotion now fires only when NO hard structural keyword is present.
describe('classifyQuery — ?-routing + hard-structural-intent (recon-prose-analyzer-04 review)', () => {
  it('a multi-word ?-question routes to fulltext, not pattern ("how does the push gate work?")', () => {
    expect(classifyQuery('how does the push gate work?')).toBe<QueryStrategy>('fulltext');
  });

  it('a multi-word ?-question with a soft keyword routes to fulltext ("why is orphan analysis unreliable?")', () => {
    expect(classifyQuery('why is orphan analysis unreliable?')).toBe<QueryStrategy>('fulltext');
  });

  it('a single token ending in "?" stays a glob pattern ("handle?")', () => {
    expect(classifyQuery('handle?')).toBe<QueryStrategy>('pattern');
  });

  it('a "*"-glob single token stays pattern ("*Handler")', () => {
    expect(classifyQuery('*Handler')).toBe<QueryStrategy>('pattern');
  });

  it('a HARD-keyword question stays structural ("which functions have no callers")', () => {
    expect(classifyQuery('which functions have no callers')).toBe<QueryStrategy>('structural');
  });

  it('a SOFT-keyword question still demotes to fulltext ("which functions are unused")', () => {
    expect(classifyQuery('which functions are unused')).toBe<QueryStrategy>('fulltext');
  });
});

// ─── (A) Hybrid fusion — the planted case (fake embedder) ────────

describe('executeFindHybrid — RRF fusion floats a vector-strong page BM25 misses', () => {
  // The "right" page has NO lexical overlap with the query (BM25 misses it) but
  // its planted vector aligns with the query embedding. A lexically-rich decoy
  // wins on BM25. Fusion must surface the correct page into the top results.
  const QUERY = 'semantic retrieval concept'; // 3 words, classifies fulltext

  function buildGraph(): { graph: KnowledgeGraph; searchText: Record<string, string> } {
    const graph = new KnowledgeGraph();
    const target = page('md:page:target.md', 'Vector Target', 'docs/target.md');
    const decoy = page('md:page:decoy.md', 'Lexical Decoy', 'docs/decoy.md');
    graph.addNode(target);
    graph.addNode(decoy);
    graph.addNode(code('ts:func:noise', 'noise', 'src/noise.ts'));
    const searchText: Record<string, string> = {
      // target: zero overlap with the query terms → BM25 score 0, absent from BM25.
      [target.id]: 'an orthogonal body about widgets and gadgets',
      // decoy: full lexical overlap → BM25 ranks it top.
      [decoy.id]: 'semantic retrieval concept overview',
    };
    return { graph, searchText };
  }

  it('BM25-alone misses the vector-strong target but fusion lands it top-5', async () => {
    const { graph, searchText } = buildGraph();
    const ranker = BM25Index.buildFromGraph(graph, searchText);

    // Plant vectors: target aligned with the query embedding, decoy orthogonal.
    const store = new VectorStore(3);
    store.add('md:page:target.md', unitVec(3, 0), NodeType.Page);
    store.add('md:page:decoy.md', unitVec(3, 1), NodeType.Page);

    // BM25-alone: lexical decoy present, the (correct) target absent.
    const bm25 = executeFind(graph, QUERY, { limit: 5 }, ranker).map(r => r.file);
    expect(bm25).toContain('docs/decoy.md');
    expect(bm25).not.toContain('docs/target.md');

    // Hybrid: the aligned vector floats the target into the results via RRF.
    const hybrid = (
      await executeFindHybrid(graph, QUERY, { limit: 5 }, store, fakeEmbed(unitVec(3, 0)), ranker)
    ).map(r => r.file);
    expect(hybrid).toContain('docs/target.md'); // surfaced only because of the vector arm
    expect(hybrid).toContain('docs/decoy.md');   // BM25 arm still contributes
  });
});

// ─── (A) Prose-scoping — the semantic arm never returns code ─────

describe('executeFindHybrid — vector search is scoped to Page/Section', () => {
  const QUERY = 'obscure unrelated lookup'; // fulltext, matches nothing lexically

  it('a code node with a perfectly-aligned vector does NOT surface (prose-scoped)', async () => {
    const graph = new KnowledgeGraph();
    graph.addNode(code('code:thing', 'CodeThing', 'src/thing.ts'));
    graph.addNode(page('md:page:prose.md', 'Prose Page', 'docs/prose.md'));
    const ranker = BM25Index.buildFromGraph(graph, { 'md:page:prose.md': 'an unrelated body' });

    const store = new VectorStore(3);
    // BOTH aligned with the query embedding — only the prose one may surface.
    store.add('code:thing', unitVec(3, 0), NodeType.Function);
    store.add('md:page:prose.md', unitVec(3, 0), NodeType.Page);

    const ids = (
      await executeFindHybrid(graph, QUERY, { limit: 5 }, store, fakeEmbed(unitVec(3, 0)), ranker)
    ).map(r => r.id);

    expect(ids).toContain('md:page:prose.md'); // prose vector surfaces
    expect(ids).not.toContain('code:thing');   // code vector excluded by the node-type scope
  });
});

// ─── (A) Fallback contract — never hard-fail on the embedding layer ──

describe('executeFindHybrid — falls back to pure BM25', () => {
  const QUERY = 'semantic retrieval concept';

  function setup() {
    const graph = new KnowledgeGraph();
    const p = page('md:page:p.md', 'Concept Page', 'docs/p.md');
    graph.addNode(p);
    graph.addNode(code('ts:func:noise', 'noise', 'src/noise.ts'));
    const ranker = BM25Index.buildFromGraph(graph, { [p.id]: 'semantic retrieval concept body' });
    const store = new VectorStore(3);
    store.add(p.id, unitVec(3, 0), NodeType.Page);
    return { graph, ranker, store };
  }

  it('vectorStore=null → identical to sync executeFind (pure BM25)', async () => {
    const { graph, ranker } = setup();
    const sync = executeFind(graph, QUERY, { limit: 5 }, ranker);
    const hybrid = await executeFindHybrid(graph, QUERY, { limit: 5 }, null, fakeEmbed(unitVec(3, 0)), ranker);
    expect(hybrid).toEqual(sync);
  });

  it('empty VectorStore → identical to sync executeFind', async () => {
    const { graph, ranker } = setup();
    const sync = executeFind(graph, QUERY, { limit: 5 }, ranker);
    const empty = new VectorStore(3);
    const hybrid = await executeFindHybrid(graph, QUERY, { limit: 5 }, empty, fakeEmbed(unitVec(3, 0)), ranker);
    expect(hybrid).toEqual(sync);
  });

  it('embedQuery that throws → falls back to BM25, never throws', async () => {
    const { graph, ranker, store } = setup();
    const sync = executeFind(graph, QUERY, { limit: 5 }, ranker);
    const throwing = async (_q: string): Promise<Float32Array> => { throw new Error('embed boom'); };
    // Must resolve (not reject) and equal the pure-BM25 result.
    const hybrid = await executeFindHybrid(graph, QUERY, { limit: 5 }, store, throwing, ranker);
    expect(hybrid).toEqual(sync);
  });

  it('embedQuery=null → identical to sync executeFind', async () => {
    const { graph, ranker, store } = setup();
    const sync = executeFind(graph, QUERY, { limit: 5 }, ranker);
    const hybrid = await executeFindHybrid(graph, QUERY, { limit: 5 }, store, null, ranker);
    expect(hybrid).toEqual(sync);
  });

  it('vectorStore.search that throws (dimension mismatch) → falls back to BM25, never rejects', async () => {
    // The review found vectorStore.search sat OUTSIDE the try/catch that wrapped
    // embedQuery, so a throw from .search (e.g. a wrong-dimension query vector)
    // escaped the BM25 fallback and rejected the promise. The whole semantic+fuse
    // block must now be inside the try → any failure degrades to pure BM25.
    const { graph, ranker, store } = setup(); // store is VectorStore(3)
    const sync = executeFind(graph, QUERY, { limit: 5 }, ranker);
    // A query embedder yielding a WRONG-dimension vector makes the REAL store.search throw.
    const wrongDim = async (_q: string): Promise<Float32Array> => unitVec(4, 0); // 4 ≠ 3
    const hybrid = await executeFindHybrid(graph, QUERY, { limit: 5 }, store, wrongDim, ranker);
    expect(hybrid).toEqual(sync);
  });

  it('no ranker → delegates to the built-in naive scan (current behavior)', async () => {
    const { graph, store } = setup();
    const noRanker = executeFind(graph, QUERY, { limit: 5 }, null);
    const hybrid = await executeFindHybrid(graph, QUERY, { limit: 5 }, store, fakeEmbed(unitVec(3, 0)), null);
    expect(hybrid).toEqual(noRanker);
  });
});

// ─── (A) Non-fulltext untouched — code retrieval not regressed ──

describe('executeFindHybrid — exact/structural delegate to sync executeFind', () => {
  function buildCodeGraph(): KnowledgeGraph {
    const g = new KnowledgeGraph();
    g.addNode(code('go:func:AuthHandler', 'AuthHandler', 'internal/auth/handler.go', { language: Language.Go, package: 'internal/auth' }));
    g.addNode(code('go:func:LoginHandler', 'LoginHandler', 'internal/auth/login.go', { language: Language.Go, package: 'internal/auth' }));
    g.addNode(code('go:func:parseToken', 'parseToken', 'internal/jwt/parse.go', { language: Language.Go, package: 'internal/jwt', exported: false }));
    return g;
  }

  it('an exact query returns exactly what sync executeFind returns (store + embedder present)', async () => {
    const g = buildCodeGraph();
    const ranker = BM25Index.buildFromGraph(g);
    const store = new VectorStore(3);
    store.add('go:func:AuthHandler', unitVec(3, 0), NodeType.Function);

    const hybrid = await executeFindHybrid(g, 'AuthHandler', undefined, store, fakeEmbed(unitVec(3, 0)), ranker);
    expect(hybrid).toEqual(executeFind(g, 'AuthHandler', undefined, ranker));
  });

  it('a structural query returns exactly what sync executeFind returns', async () => {
    const g = buildCodeGraph();
    const ranker = BM25Index.buildFromGraph(g);
    const store = new VectorStore(3);
    store.add('go:func:AuthHandler', unitVec(3, 0), NodeType.Function);

    const q = 'exported functions with no callers';
    const hybrid = await executeFindHybrid(g, q, undefined, store, fakeEmbed(unitVec(3, 0)), ranker);
    expect(hybrid).toEqual(executeFind(g, q, undefined, ranker));
  });
});

// ─── (A) Handler wiring — recon_find forwards vectorStore + BM25 fallback ──

describe('recon_find handler — vectorStore forwarding + BM25 fallback (AC wiring)', () => {
  afterEach(() => setFulltextRanker(null));

  it('a conceptual query surfaces the documenting page; a present store with no ready embedder falls back to BM25 (no throw)', async () => {
    const { handleToolCall } = await import('../../src/mcp/handlers.js');

    const graph = new KnowledgeGraph();
    const p = page('md:page:doc-sync.md', 'Doc Sync Pattern', 'docs/doc-sync.md');
    graph.addNode(p);
    graph.addNode(code('ts:func:syncJSDoc', 'syncJSDoc', 'src/sync.ts'));
    setFulltextRanker(BM25Index.buildFromGraph(graph, {
      [p.id]: 'Doc Sync Pattern — the documentation synchronization pattern keeps prose aligned with the code it documents',
    }));

    // A vector store is present, but the embedder singleton is NOT initialized in
    // vitest → handleFind builds embedQuery=null → executeFindHybrid falls back to
    // BM25 with no hard failure. Proves the last-hop wiring + the fallback AC.
    const store = new VectorStore(384);
    store.add(p.id, unitVec(384, 0), NodeType.Page);

    const out = await handleToolCall(
      'recon_find',
      { query: 'what is the documentation synchronization pattern' }, // interrogative → fulltext
      graph,
      undefined,
      store,
    );
    expect(out).toContain('Doc Sync Pattern');
  });
});

// ─── (A) Relevance floor — gibberish no longer backfills (qa-finding-03, P1.5 A) ──

describe('executeFindHybrid — SEMANTIC_FLOOR drops sub-floor nearest neighbors (P1.5 slice A)', () => {
  // vectorStore.search returns the k nearest neighbors REGARDLESS of cosine, so a
  // gibberish query (no BM25 match, no truly-similar prose) used to backfill the
  // pool with low-cosine neighbors and never say "No results" (qa-finding-03). The
  // floor drops every semantic hit below SEMANTIC_FLOOR before fusion, so such a
  // query fuses to empty — while a genuine (high-cosine) match still survives.

  it('a gibberish fulltext query with only sub-floor (orthogonal) prose vectors → []', async () => {
    const graph = new KnowledgeGraph();
    const widget = page('md:page:widget.md', 'Widget Page', 'docs/widget.md');
    graph.addNode(widget);
    graph.addNode(code('ts:func:noise', 'noise', 'src/noise.ts'));
    const ranker = BM25Index.buildFromGraph(graph, {
      [widget.id]: 'a page entirely about widgets and gadgets',
    });
    const store = new VectorStore(3);
    // Orthogonal to the query embedding → cosine 0, below any positive floor.
    store.add(widget.id, unitVec(3, 1), NodeType.Page);

    // 3 words → fulltext; zero lexical overlap with the widget body → BM25 empty.
    const GIBBERISH = 'xylophone zeppelin quasar';
    const out = await executeFindHybrid(
      graph, GIBBERISH, { limit: 50 }, store, fakeEmbed(unitVec(3, 0)), ranker,
    );
    expect(out).toEqual([]); // no backfill — qa-finding-03 closed
  });

  it('a real conceptual query whose target vector is above floor is still retrieved', async () => {
    const graph = new KnowledgeGraph();
    const target = page('md:page:concept.md', 'Concept Page', 'docs/concept.md');
    graph.addNode(target);
    graph.addNode(code('ts:func:noise', 'noise', 'src/noise.ts'));
    // Body shares NO term with the query → BM25 misses it; only the vector arm can
    // surface it, so this proves the floor does not kill a genuine semantic match.
    const ranker = BM25Index.buildFromGraph(graph, {
      [target.id]: 'an orthogonal body about widgets and gadgets',
    });
    const store = new VectorStore(3);
    store.add(target.id, unitVec(3, 0), NodeType.Page); // cosine 1.0 with query → above floor

    const out = await executeFindHybrid(
      graph, 'semantic retrieval concept', { limit: 5 }, store, fakeEmbed(unitVec(3, 0)), ranker,
    );
    expect(out.map(r => r.file)).toContain('docs/concept.md');
  });
});

// ─── (B) Weighted RRF — a confident BM25 #1 is not displaced (hit@1 lock, P1.5 A) ──

describe('mergeWithRRF — weighted RRF protects a confident BM25 #1 (P1.5 slice A)', () => {
  // `target` is the confident BM25 #1 with no semantic signal. `decoy` is a
  // MEDIOCRE BM25 match (ranked far down) that happens to be semantic #1. Under
  // EQUAL-weight RRF the decoy's full semantic term rides it above the BM25 #1 —
  // the hit@1 regression. Down-weighting the semantic arm (default 0.5) keeps the
  // confident #1 on top. mergeWithRRF is the seam executeFindHybrid fuses through
  // (with these same defaults), so locking it here locks the end-to-end behavior.
  //
  // DEVIATION FROM SPEC SKETCH: the spec sketched the decoy at "BM25 #2", but under
  // RRF_K=60 a literal #2 is a STRONG lexical match fusion legitimately promotes,
  // and NO semanticWeight in (0,1] with bm25Weight=1.0 lets a BM25 #1 outrank a
  // (#2 + semantic #1) item — that needs semanticWeight < 1/62 ≈ 0.016, which guts
  // the semantic arm. The regression the change targets is a *mediocre* (far-down)
  // BM25 item riding semantic rank, so the decoy is planted mediocre-in-BM25 —
  // matching the spec's own prose ("a both-list item only mediocre in BM25").
  function planted(): { bm25: BM25Result[]; semantic: VectorSearchResult[] } {
    const bm25: BM25Result[] = [{ nodeId: 'target', score: 50 }]; // confident BM25 #1
    for (let i = 0; i < 100; i++) bm25.push({ nodeId: `noise${i}`, score: 40 - i * 0.1 });
    bm25.push({ nodeId: 'decoy', score: 1 }); // mediocre BM25 (rank ~102), far down
    const semantic: VectorSearchResult[] = [{ nodeId: 'decoy', score: 0.95 }]; // semantic #1
    return { bm25, semantic };
  }

  it('OLD equal-weight RRF lets the both-list decoy displace the BM25 #1 (regression)', () => {
    const { bm25, semantic } = planted();
    const equal = mergeWithRRF(bm25, semantic, 200, 1.0, 1.0);
    expect(equal[0].nodeId).toBe('decoy'); // the regression: confident #1 demoted
  });

  it('weighted RRF (default semanticWeight) keeps the confident BM25 #1 first', () => {
    const { bm25, semantic } = planted();
    const weighted = mergeWithRRF(bm25, semantic, 200); // defaults: bm25 1.0, semantic 0.5
    expect(weighted[0].nodeId).toBe('target'); // hit@1 recovered
  });
});

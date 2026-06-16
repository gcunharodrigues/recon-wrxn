/**
 * recon_find — Natural Language Query Routing
 *
 * Classifies a free-text query into one of four strategies and executes
 * the appropriate search over the knowledge graph.
 */

import type { KnowledgeGraph, Node } from '../graph/index.js';
import { NodeType, RelationshipType } from '../graph/index.js';
import { mergeWithRRF } from '../search/hybrid-search.js';
import type { VectorStore } from '../search/vector-store.js';

// ─── Types ──────────────────────────────────────────────────────

export type QueryStrategy = 'exact' | 'pattern' | 'structural' | 'fulltext';

export interface FindResult {
  id: string;
  name: string;
  type: NodeType;
  file: string;
  line: number;
  package: string;
  exported: boolean;
  callers: number;
  callees: number;
  method?: boolean;
  // ─── Hybrid retrieval signal (recon-brain-recall-01) ───
  // Populated ONLY on the hybrid fulltext path, where mergeWithRRF computes the
  // per-arm signal; undefined on exact/pattern/structural and the BM25-fallback
  // paths. formatFindResults ignores these (the agent markdown is unchanged) — the
  // HTTP door projects them into the structured `hits` array (toFindHits) for
  // node-stdlib consumers (the Recall hook) that cannot compute a cosine themselves.
  score?: number;                     // combined RRF score
  sources?: ('bm25' | 'semantic')[];  // arm provenance; both arms = the consensus signal
  bm25Score?: number;                 // original BM25 score
  semanticScore?: number;             // original cosine similarity (semantic arm)
}

/**
 * The structured per-hit shape the HTTP find door returns alongside the agent
 * markdown (recon-brain-recall-01). A projection of FindResult down to what a
 * node-stdlib consumer reads: identity + location + the per-arm retrieval signal.
 */
export interface FindHit {
  id: string;
  name: string;
  type: NodeType;
  file: string;
  line: number;
  score?: number;
  sources?: ('bm25' | 'semantic')[];
  bm25Score?: number;
  semanticScore?: number;
}

export interface FindOptions {
  limit?: number;
  type?: NodeType;
}

/**
 * A ranked fulltext retriever. The fulltext strategy delegates ranking to an
 * implementation of this interface (e.g. an in-memory BM25 index built on serve
 * from the graph + prose searchText). Decoupling here keeps find.ts free of the
 * concrete index and lets the serve wiring inject it without find.ts importing it.
 */
export interface FulltextRanker {
  search(query: string, limit?: number): Array<{ nodeId: string; score: number }>;
}

/**
 * Embeds a query string into a vector. Injected by the serve path (transformers.js
 * via embedder.ts), so find.ts stays free of the optional embedding dependency and
 * the hybrid path is unit-testable with a fake embedder.
 */
export type EmbedQuery = (query: string) => Promise<Float32Array>;

// Process-default ranker. serveCommand installs the BM25 index here so the live
// recon_find path (handlers → executeFind, 3 args) ranks prose body without any
// change to the handler. Null until installed → fulltext falls back to the
// name/file token scan, preserving behavior for callers that inject nothing.
let defaultRanker: FulltextRanker | null = null;

export function setFulltextRanker(ranker: FulltextRanker | null): void {
  defaultRanker = ranker;
}

// ─── Structural Keywords ─────────────────────────────────────────

const STRUCTURAL_KEYWORDS = [
  'exported',
  'unexported',
  'no callers',
  'no callees',
  'unused',
  'implements',
  'extends',
  'orphan',
  'dead',
  'circular',
  'test',
  'entry point',
] as const;

// Words that open a natural-language QUESTION. A query led by one of these (or
// containing '?') is conceptual, so a lone structural keyword inside it (e.g.
// "orphan" in "why is orphan analysis unreliable") must not divert it to the
// structural strategy — it belongs in fulltext/hybrid retrieval.
const INTERROGATIVES: ReadonlySet<string> = new Set([
  'how', 'why', 'what', 'where', 'when', 'who', 'which',
  'does', 'do', 'is', 'are', 'can', 'should', 'explain', 'describe',
]);

// A subset of STRUCTURAL_KEYWORDS that is UNAMBIGUOUSLY structural — these never
// double as ordinary English the way the SOFT keywords (unused/orphan/dead/test)
// do. A question carrying one of these expresses real structural intent (e.g.
// "which functions have no callers") and must NOT be demoted to fulltext, where
// caller/callee counts can't be computed.
const HARD_STRUCTURAL_KEYWORDS = [
  'exported', 'unexported', 'no callers', 'no callees',
  'implements', 'extends', 'entry point', 'circular',
] as const;

// ─── Classification ──────────────────────────────────────────────

/**
 * Count how many structural keywords appear in the query.
 * Multi-word keywords (e.g. "no callers") count as one.
 */
function countStructuralKeywords(query: string): number {
  const lower = query.toLowerCase();
  let count = 0;
  for (const kw of STRUCTURAL_KEYWORDS) {
    if (lower.includes(kw)) {
      count++;
    }
  }
  return count;
}

/** True if the query carries an unambiguously-structural (HARD) keyword. */
function hasHardStructuralKeyword(query: string): boolean {
  const lower = query.toLowerCase();
  return HARD_STRUCTURAL_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Classify a natural-language query into a search strategy.
 *
 * Rules (evaluated in order):
 *  1. Contains `*` or `?`                             → pattern
 *  2. Single token that looks like code                → exact
 *  2b. Interrogative-led question + <2 structural kw   → fulltext
 *  3. 2+ structural keywords                           → structural
 *  4. 1 structural keyword + 3+ words total            → structural
 *  5. Otherwise                                        → fulltext
 */
export function classifyQuery(query: string): QueryStrategy {
  const trimmed = query.trim();

  // Rule 1: wildcard. '*' is always a glob. '?' is a glob ONLY for a single
  // whitespace-free token ("handle?") — a multi-word natural-language question
  // ending in/containing '?' ("how does the push gate work?") must fall through
  // to the classifier rules instead of being force-matched as a (no-match)
  // pattern, which broke the headline conceptual-query use case.
  if (trimmed.includes('*') || (trimmed.includes('?') && !/\s/.test(trimmed))) {
    return 'pattern';
  }

  // Rule 2: single code-like token
  // Code-like: camelCase, snake_case, dot.notation, PascalCase — no spaces, no pure lowercase English words
  const words = trimmed.split(/\s+/);
  if (words.length === 1) {
    const token = words[0];
    // Looks like code if it contains uppercase, underscore, or dot
    const isCodeLike =
      /[A-Z]/.test(token) ||          // has uppercase (camelCase / PascalCase)
      token.includes('_') ||           // snake_case
      token.includes('.');             // dot.notation
    if (isCodeLike) return 'exact';
    // Single short word (like "auth") → exact
    return 'exact';
  }

  // Count structural keywords
  const kwCount = countStructuralKeywords(trimmed);
  const wordCount = words.length;

  // Rule 2b: a conceptual QUESTION (interrogative-led or '?') with a weak
  // structural signal (<2 keywords) is natural language → fulltext, even when it
  // happens to contain one structural keyword (e.g. "why is … orphan analysis …"
  // trips "orphan"). The <2 guard preserves a genuinely structural question
  // ("what are the exported functions with no callers" = 2 kw stays structural).
  const isQuestion = INTERROGATIVES.has(words[0].toLowerCase()) || trimmed.includes('?');
  if (isQuestion && kwCount < 2 && !hasHardStructuralKeyword(trimmed)) {
    return 'fulltext';
  }

  // Rule 3: 2+ structural keywords → structural
  if (kwCount >= 2) {
    return 'structural';
  }

  // Rule 4: 1 structural keyword + 3+ words → structural
  if (kwCount === 1 && wordCount >= 3) {
    return 'structural';
  }

  // Rule 4b: 1 structural keyword + exactly 2 words (e.g. "unused exports") → structural
  if (kwCount === 1 && wordCount === 2) {
    return 'structural';
  }

  // Rule 5: fulltext
  return 'fulltext';
}

// ─── Strategy Implementations ────────────────────────────────────

/**
 * Tokenize a camelCase / PascalCase / snake_case name into lowercase parts.
 */
function tokenizeName(name: string): string[] {
  // Split on underscores, dots, then camelCase boundaries
  const parts = name
    .replace(/[_.]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return parts;
}

/**
 * Build a FindResult from a Node plus its graph relationships.
 */
function buildResult(node: Node, graph: KnowledgeGraph): FindResult {
  const callers = graph.getIncoming(node.id, RelationshipType.CALLS).length
    + graph.getIncoming(node.id, RelationshipType.CALLS_API).length
    + graph.getIncoming(node.id, RelationshipType.USES_COMPONENT).length;

  const callees = graph.getOutgoing(node.id, RelationshipType.CALLS).length
    + graph.getOutgoing(node.id, RelationshipType.CALLS_API).length
    + graph.getOutgoing(node.id, RelationshipType.USES_COMPONENT).length;

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.file,
    line: node.startLine,
    package: node.package,
    exported: node.exported,
    callers,
    callees,
    method: node.type === NodeType.Method,
  };
}

/**
 * Apply type filter and limit to a result set.
 */
function applyOptions(
  results: FindResult[],
  options: FindOptions | undefined,
): FindResult[] {
  if (options?.type !== undefined) {
    results = results.filter(r => r.type === options.type);
  }
  if (options?.limit !== undefined && options.limit > 0) {
    results = results.slice(0, options.limit);
  }
  return results;
}

// ─── Exact Search ────────────────────────────────────────────────

function searchExact(
  graph: KnowledgeGraph,
  query: string,
  options?: FindOptions,
): FindResult[] {
  const nodes = graph.findByName(query); // already case-insensitive
  const results = nodes.map(n => buildResult(n, graph));
  return applyOptions(results, options);
}

// ─── Pattern Search ──────────────────────────────────────────────

/**
 * Convert a glob-style wildcard pattern to a RegExp (case-insensitive).
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function searchPattern(
  graph: KnowledgeGraph,
  query: string,
  options?: FindOptions,
): FindResult[] {
  const regex = wildcardToRegex(query);
  const results: FindResult[] = [];

  for (const node of graph.nodes.values()) {
    if (regex.test(node.name)) {
      results.push(buildResult(node, graph));
    }
  }

  return applyOptions(results, options);
}

// ─── Structural Search ───────────────────────────────────────────

function searchStructural(
  graph: KnowledgeGraph,
  query: string,
  options?: FindOptions,
): FindResult[] {
  const lower = query.toLowerCase();

  const wantsExported = lower.includes('exported') && !lower.includes('unexported');
  const wantsUnexported = lower.includes('unexported');
  const wantsNoCallers = lower.includes('no callers');
  const wantsNoCallees = lower.includes('no callees');
  const wantsUnused = lower.includes('unused');
  const wantsTest = lower.includes('test');
  const wantsOrphan = lower.includes('orphan');
  const wantsDead = lower.includes('dead');
  const wantsImplements = lower.includes('implements');
  const wantsExtends = lower.includes('extends');
  const wantsEntryPoint = lower.includes('entry point');

  const results: FindResult[] = [];

  for (const node of graph.nodes.values()) {
    // Skip file/package nodes for structural queries (usually not what the user wants)
    if (node.type === NodeType.File || node.type === NodeType.Package) continue;

    const result = buildResult(node, graph);

    // Apply filters
    if (wantsExported && !node.exported) continue;
    if (wantsUnexported && node.exported) continue;
    if (wantsNoCallers && result.callers > 0) continue;
    if (wantsNoCallees && result.callees > 0) continue;
    if (wantsUnused && result.callers > 0) continue;  // "unused" = no callers
    if (wantsTest && !node.isTest) continue;
    if (wantsOrphan && result.callers > 0) continue;  // "orphan" = no callers
    if (wantsDead && result.callers > 0) continue;    // "dead" = no callers
    if (wantsEntryPoint && result.callers > 0) continue; // entry point = no callers
    if (wantsImplements) {
      // Filter to nodes that have an IMPLEMENTS relationship
      const hasImpl =
        graph.getOutgoing(node.id, RelationshipType.IMPLEMENTS).length > 0 ||
        graph.getIncoming(node.id, RelationshipType.IMPLEMENTS).length > 0;
      if (!hasImpl) continue;
    }
    if (wantsExtends) {
      const hasExt =
        graph.getOutgoing(node.id, RelationshipType.EXTENDS).length > 0 ||
        graph.getIncoming(node.id, RelationshipType.EXTENDS).length > 0;
      if (!hasExt) continue;
    }

    results.push(result);
  }

  return applyOptions(results, options);
}

// ─── Fulltext Search ─────────────────────────────────────────────

function searchFulltext(
  graph: KnowledgeGraph,
  query: string,
  options?: FindOptions,
  ranker?: FulltextRanker | null,
): FindResult[] {
  // Ranked path: a BM25 (or compatible) index ranks every node — code over
  // name/file/package, prose over its searchText body. Map the ranked ids back
  // to graph nodes, then apply type/limit. This replaces the naive +2/+1 scan
  // as the live fulltext ranker (the scan remains the no-ranker fallback below).
  if (ranker) {
    const ranked = ranker.search(query, graph.nodeCount || undefined);
    const results: FindResult[] = [];
    for (const { nodeId } of ranked) {
      const node = graph.getNode(nodeId);
      if (node) results.push(buildResult(node, graph));
    }
    return applyOptions(results, options);
  }

  // Tokenize the query into terms
  const queryTokens = tokenizeName(query.replace(/[^\w\s]/g, ' '));

  if (queryTokens.length === 0) {
    return [];
  }

  const scored: Array<{ result: FindResult; score: number }> = [];

  for (const node of graph.nodes.values()) {
    const nameTokens = tokenizeName(node.name);
    const fileTokens = node.file ? tokenizeName(node.file.replace(/[/\\.]/g, ' ')) : [];
    const allTokens = [...nameTokens, ...fileTokens];

    let score = 0;
    for (const qt of queryTokens) {
      for (const nt of allTokens) {
        if (nt === qt) {
          score += 2;  // exact token match
        } else if (nt.includes(qt) || qt.includes(nt)) {
          score += 1;  // partial match
        }
      }
    }

    if (score > 0) {
      scored.push({ result: buildResult(node, graph), score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const results = scored.map(s => s.result);
  return applyOptions(results, options);
}

// ─── Main Dispatcher ─────────────────────────────────────────────

/**
 * Execute a find operation using the appropriate strategy.
 */
export function executeFind(
  graph: KnowledgeGraph,
  query: string,
  options?: FindOptions,
  ranker: FulltextRanker | null = defaultRanker,
): FindResult[] {
  const strategy = classifyQuery(query);

  switch (strategy) {
    case 'exact':
      return searchExact(graph, query, options);
    case 'pattern':
      return searchPattern(graph, query, options);
    case 'structural':
      return searchStructural(graph, query, options);
    case 'fulltext':
      return searchFulltext(graph, query, options, ranker);
  }
}

/**
 * Hybrid retrieval: BM25 ⊕ node-type-scoped vector search, fused via Reciprocal
 * Rank Fusion (recon-prose-analyzer-04). Enhances ONLY the fulltext strategy; every
 * other strategy and every missing-input case delegates to the sync `executeFind`
 * so behavior is unchanged when embeddings are absent.
 *
 * Fallback to pure BM25 (the built-in fallback the dilution gate relies on) when:
 *  - the query is not fulltext (exact/pattern/structural code retrieval), or
 *  - there is no ranker, no vector store, an empty store, or no query embedder, or
 *  - embedding the query throws (the embedding layer never hard-fails retrieval).
 *
 * Otherwise: rank BM25 over a wide candidate pool, embed the query, search the
 * vector store SCOPED to prose node-types (Page/Section — so code keeps its BM25
 * rank and prose vectors don't dilute code vectors, decision 27), fuse the two
 * ranked lists with RRF, map the fused ids back to graph nodes, then apply
 * type/limit. `ranker.search` returns `{nodeId,score}[]`, structurally a
 * `BM25Result`, so it feeds `mergeWithRRF` directly.
 */
/**
 * TUNABLE — minimum cosine similarity a semantic hit must clear to enter fusion
 * (P1.5 slice A). VectorSearchResult.score is cosine similarity in [0,1], and
 * vectorStore.search returns the k nearest neighbors REGARDLESS of similarity, so a
 * gibberish query (no BM25 match, no truly-similar prose) backfills the pool with
 * low-cosine neighbors and "No results" never happens (qa-finding-03). Dropping
 * every semantic hit below this floor BEFORE fusion means such a query fuses to
 * empty → "No results", while a genuine conceptual match (high cosine) is retained.
 *
 * 0.4 is tuned on the real WRXN-OS prose corpus (P1.5 slice A out-of-band sweep):
 * all-MiniLM-L6-v2 is anisotropic — pure-gibberish queries still score 0.30–0.48
 * cosine against unrelated pages, so a 0.3 floor let a nonsense query keep ~32/50
 * neighbors. 0.4 sits just above that gibberish band yet below the real-target
 * cosine median (~0.49); it empties true gibberish (0 BM25, 0 above-floor) while
 * keeping GOLD hit@5 at 100% — the 5/16 low-cosine real targets are carried by the
 * BM25 arm, which the floor never gates. Above ~0.45 a real target starts dropping.
 */
const SEMANTIC_FLOOR = 0.4;

export async function executeFindHybrid(
  graph: KnowledgeGraph,
  query: string,
  options: FindOptions | undefined,
  vectorStore: VectorStore | null | undefined,
  embedQuery: EmbedQuery | null,
  ranker: FulltextRanker | null = defaultRanker,
): Promise<FindResult[]> {
  // Hybrid only enhances fulltext — everything else is the sync path verbatim.
  if (classifyQuery(query) !== 'fulltext') {
    return executeFind(graph, query, options, ranker);
  }

  // Built-in fallback: any missing hybrid input → pure BM25 (current behavior).
  if (!ranker || !vectorStore || vectorStore.size === 0 || !embedQuery) {
    return executeFind(graph, query, options, ranker);
  }

  // Wide candidate pool before the final limit, so fusion has room to re-rank.
  const pool = Math.max((options?.limit ?? 0) * 4, 50);

  const bm25Results = ranker.search(query, pool);

  // The semantic arm (embed query → vector search → RRF fuse) must never hard-fail
  // retrieval. Wrap the WHOLE block — not just embedQuery — so a throw from
  // vectorStore.search (e.g. a dimension mismatch) also degrades to pure BM25.
  try {
    const queryEmbedding = await embedQuery(query);

    const semanticResults = vectorStore.search(queryEmbedding, pool, {
      nodeType: [NodeType.Page, NodeType.Section],
    });

    // Relevance floor: drop near-neighbors below SEMANTIC_FLOOR so a query with no
    // above-floor semantic match (and no BM25 match) fuses to empty instead of
    // backfilling the pool with irrelevant nearest neighbors (qa-finding-03).
    const flooredSemantic = semanticResults.filter(r => r.score >= SEMANTIC_FLOOR);

    const fused = mergeWithRRF(bm25Results, flooredSemantic, pool);

    // Carry the per-arm signal (RRF score, arm provenance, bm25/semantic scores)
    // onto each FindResult — the keystone (recon-brain-recall-01). The map used to
    // keep only the nodeId, discarding the cosine + consensus flag the door must
    // surface. formatFindResults still ignores these, so the markdown is unchanged.
    const results: FindResult[] = [];
    for (const f of fused) {
      const node = graph.getNode(f.nodeId);
      if (!node) continue;
      results.push({
        ...buildResult(node, graph),
        score: f.score,
        sources: f.sources,
        bm25Score: f.bm25Score,
        semanticScore: f.semanticScore,
      });
    }
    return applyOptions(results, options);
  } catch {
    return executeFind(graph, query, options, ranker);
  }
}

// ─── Formatting ──────────────────────────────────────────────────

/**
 * Format FindResult[] as a markdown string for MCP tool responses.
 */
export function formatFindResults(results: FindResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [
    `**Found ${results.length} result${results.length === 1 ? '' : 's'}**`,
    '',
  ];

  for (const r of results) {
    const exportTag = r.exported ? 'exported' : 'unexported';
    const callerInfo = `${r.callers} caller${r.callers === 1 ? '' : 's'}`;
    const calleeInfo = `${r.callees} callee${r.callees === 1 ? '' : 's'}`;

    lines.push(`- **${r.name}** (${r.type}) [${exportTag}]`);
    lines.push(`  \`${r.file}:${r.line}\` — ${r.package}`);
    lines.push(`  ${callerInfo}, ${calleeInfo}`);
  }

  return lines.join('\n');
}

/**
 * Project FindResult[] to the structured per-hit wire shape (recon-brain-recall-01).
 * The HTTP find door returns this alongside the markdown so a node-stdlib consumer
 * reads identity + location + the per-arm signal. Score fields ride through only on
 * the hybrid fulltext path; they are simply absent (undefined) otherwise.
 */
export function toFindHits(results: FindResult[]): FindHit[] {
  return results.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    file: r.file,
    line: r.line,
    score: r.score,
    sources: r.sources,
    bm25Score: r.bm25Score,
    semanticScore: r.semanticScore,
  }));
}

/**
 * Hybrid Search — BM25 + Vector with Reciprocal Rank Fusion
 *
 * Combines keyword search (BM25) with semantic search (vector embeddings)
 * using RRF to merge rankings without score normalization.
 *
 * When embeddings are not available, falls back to pure BM25.
 */

import type { BM25Result } from './bm25.js';
import type { VectorSearchResult } from './vector-store.js';

// ─── RRF Constant ───────────────────────────────────────────────

/**
 * Standard RRF constant from the literature.
 * Higher values give more weight to lower-ranked results.
 */
const RRF_K = 60;

// ─── Types ──────────────────────────────────────────────────────

export interface HybridSearchResult {
  nodeId: string;
  score: number;          // Combined RRF score
  sources: ('bm25' | 'semantic')[];
  bm25Score?: number;     // Original BM25 score
  semanticScore?: number; // Original cosine similarity
}

// ─── RRF Merge ──────────────────────────────────────────────────

/**
 * Merge BM25 and vector search results using Reciprocal Rank Fusion.
 * Items found by both methods get boosted scores.
 *
 * `bm25Weight` / `semanticWeight` are TUNABLE per-arm weights (P1.5 slice A): each
 * arm contributes `weight * 1/(RRF_K + rank)`. Down-weighting the semantic arm
 * (default 0.5) makes a confident BM25 #1 harder to displace by a both-list item
 * that is only mediocre in BM25, recovering the hit@1 the equal-weight fusion
 * regressed. New optional params with defaults keep existing callers unchanged; the
 * main thread validates/tunes the values against the real corpus out-of-band.
 */
export function mergeWithRRF(
  bm25Results: BM25Result[],
  semanticResults: VectorSearchResult[],
  limit: number = 20,
  bm25Weight: number = 1.0,
  semanticWeight: number = 0.5,
): HybridSearchResult[] {
  const merged = new Map<string, HybridSearchResult>();

  // Process BM25 results
  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    const rrfScore = bm25Weight * (1 / (RRF_K + i + 1));

    merged.set(r.nodeId, {
      nodeId: r.nodeId,
      score: rrfScore,
      sources: ['bm25'],
      bm25Score: r.score,
    });
  }

  // Process semantic results and merge
  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    const rrfScore = semanticWeight * (1 / (RRF_K + i + 1));

    const existing = merged.get(r.nodeId);
    if (existing) {
      // Found by both — sum RRF scores
      existing.score += rrfScore;
      existing.sources.push('semantic');
      existing.semanticScore = r.score;
    } else {
      merged.set(r.nodeId, {
        nodeId: r.nodeId,
        score: rrfScore,
        sources: ['semantic'],
        semanticScore: r.score,
      });
    }
  }

  // Sort by combined RRF score descending
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted;
}

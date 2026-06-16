/**
 * In-Memory Vector Store
 *
 * Stores embeddings as Float32Arrays and supports cosine similarity search.
 * Serializable to JSON for persistence in .recon-wrxn/embeddings.json.
 */

import type { NodeType } from '../graph/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface VectorEntry {
  nodeId: string;
  embedding: Float32Array;
  /**
   * The node's type, so search can be scoped to one modality (code vs prose)
   * and the two don't dilute each other in one undifferentiated vector space.
   * Optional for backward compatibility with embeddings.json written before
   * node-type scoping existed — such entries are excluded from any scoped query.
   */
  nodeType?: NodeType;
}

export interface VectorSearchResult {
  nodeId: string;
  score: number; // cosine similarity (0-1, higher is better)
}

/** Scope a vector search to one or more node types (e.g. Page/Section for prose). */
export interface VectorSearchOptions {
  nodeType?: NodeType | NodeType[];
}

export interface SerializedVectorStore {
  dimensions: number;
  entries: Array<{
    nodeId: string;
    embedding: number[];
    nodeType?: NodeType;
  }>;
}

// ─── Cosine Similarity ─────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ─── VectorStore ────────────────────────────────────────────────

export class VectorStore {
  private entries: VectorEntry[] = [];
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  /**
   * Add a vector entry to the store. `nodeType` enables node-type-scoped search.
   */
  add(nodeId: string, embedding: Float32Array, nodeType?: NodeType): void {
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`,
      );
    }
    this.entries.push({ nodeId, embedding, nodeType });
  }

  /**
   * Search for the k nearest neighbors by cosine similarity.
   *
   * When `options.nodeType` is given, only entries of those types are considered,
   * so code and prose can be queried independently and don't compete in one space.
   * Untyped entries (legacy embeddings.json) are excluded from any scoped query.
   */
  search(query: Float32Array, k: number = 10, options?: VectorSearchOptions): VectorSearchResult[] {
    if (query.length !== this.dimensions) {
      throw new Error(
        `Query dimension mismatch: expected ${this.dimensions}, got ${query.length}`,
      );
    }

    const filter = options?.nodeType;
    const allowed = filter == null ? null : new Set(Array.isArray(filter) ? filter : [filter]);

    const scored: VectorSearchResult[] = [];

    for (const entry of this.entries) {
      if (allowed && (entry.nodeType === undefined || !allowed.has(entry.nodeType))) continue;
      const score = cosineSimilarity(query, entry.embedding);
      scored.push({ nodeId: entry.nodeId, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /**
   * Get a node's stored embedding, or undefined if absent. Lets an incremental
   * re-index carry an unchanged node's vector forward without re-embedding it.
   */
  get(nodeId: string): Float32Array | undefined {
    return this.entries.find(e => e.nodeId === nodeId)?.embedding;
  }

  /**
   * Check if a node already has an embedding.
   */
  has(nodeId: string): boolean {
    return this.entries.some(e => e.nodeId === nodeId);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Get all node IDs that have embeddings.
   */
  nodeIds(): Set<string> {
    return new Set(this.entries.map(e => e.nodeId));
  }

  /**
   * Serialize for JSON persistence.
   */
  serialize(): SerializedVectorStore {
    return {
      dimensions: this.dimensions,
      entries: this.entries.map(e => ({
        nodeId: e.nodeId,
        embedding: Array.from(e.embedding),
        nodeType: e.nodeType,
      })),
    };
  }

  /**
   * Deserialize from JSON. Tolerates legacy entries with no `nodeType`.
   */
  static deserialize(data: SerializedVectorStore): VectorStore {
    const store = new VectorStore(data.dimensions);
    for (const entry of data.entries) {
      // Drop any wrong-dimension vector (corrupt/legacy embeddings.json) — an
      // off-dimension embedding yields NaN cosine scores. add() guards the live
      // path; deserialize must guard the persisted path the same way.
      if (entry.embedding.length !== data.dimensions) continue;
      store.entries.push({
        nodeId: entry.nodeId,
        embedding: new Float32Array(entry.embedding),
        nodeType: entry.nodeType,
      });
    }
    return store;
  }
}

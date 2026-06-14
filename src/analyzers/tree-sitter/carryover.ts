/**
 * Incremental carry-over for tree-sitter languages.
 *
 * On a non-`--force` index, unchanged files are skipped and produce zero fresh
 * nodes. The previous index's nodes for those files must be carried forward, or
 * an all-tree-sitter repo with no changes collapses to an empty graph (the
 * long-standing "plain `recon index` empties the graph, only --force works" bug).
 *
 * The TypeScript analyzer has its own carry-over (TS-only) inline in indexCommand;
 * this is the tree-sitter equivalent, factored out as a pure graph operation so the
 * merge correctness (no ghost nodes, no dangling rels, deleted/parse-failed files
 * dropped) is unit-testable without the filesystem / worker-pool / embedding stack.
 */

import type { Language } from '../../graph/types.js';
import type { KnowledgeGraph } from '../../graph/graph.js';

/**
 * Merge UNCHANGED tree-sitter symbols (and their relationships) from a previous
 * index into the freshly-built `graph`, in place.
 *
 * A previous node is carried forward ONLY when all three hold:
 *  1. its language is an active tree-sitter language (TS / cross-language nodes are
 *     owned by other passes and must not be duplicated here);
 *  2. its file was NOT re-analyzed this run — a re-analyzed file already contributed
 *     fresh nodes, so carrying its previous (stale) nodes would duplicate/poison them;
 *  3. its file still appears in the new fileHashes — a file that was deleted, became
 *     ignored, or FAILED to parse this run is absent from fileHashes and is dropped.
 *
 * Relationships are carried with AND semantics: a previous rel survives only if BOTH
 * endpoints exist in the merged graph. This is intentionally stricter than the TS
 * carry-over's OR semantics — a tree-sitter edge whose source or target was dropped
 * (deleted file, or a line-shifted symbol re-keyed under a new id) must not linger as
 * a dangling/ghost edge.
 *
 * @param graph          The freshly-built graph for this run (mutated in place).
 * @param previousGraph  The previous index's graph.
 * @param tsitterLangs   Active tree-sitter languages (from getAvailableLanguages()).
 * @param analyzedFiles  Project-relative paths re-analyzed (and successfully extracted) this run.
 * @param newFileHashes  fileHashes of the new index (skipped-unchanged ∪ freshly-succeeded).
 */
export function carryOverUnchangedTreeSitter(
  graph: KnowledgeGraph,
  previousGraph: KnowledgeGraph,
  tsitterLangs: Language[],
  analyzedFiles: Iterable<string>,
  newFileHashes: Record<string, string>,
): void {
  const langSet = new Set<string>(tsitterLangs);
  const analyzed = new Set(analyzedFiles);

  for (const node of previousGraph.nodes.values()) {
    if (!langSet.has(node.language)) continue;
    if (analyzed.has(node.file)) continue;
    if (!(node.file in newFileHashes)) continue;
    if (!graph.getNode(node.id)) {
      graph.addNode(node);
    }
  }

  for (const rel of previousGraph.allRelationships()) {
    if (graph.getRelationship(rel.id)) continue;
    if (graph.getNode(rel.sourceId) && graph.getNode(rel.targetId)) {
      graph.addRelationship(rel);
    }
  }
}

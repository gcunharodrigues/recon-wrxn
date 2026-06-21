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
import { getLanguageForFile } from './parser.js';

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

/**
 * Preventive carry-over correctness: drop the hashes of UNCHANGED code files that
 * the previous graph holds NO tree-sitter symbols for, so the next analyzer pass
 * re-parses them instead of carrying them empty.
 *
 * The unconditional carry-over above (and the analyzer's hash-match skip that feeds
 * it) assumes "unchanged file ⇒ its previous symbols are valid". That breaks under
 * PARTIAL degradation: a file recorded as seen (hash present) whose previous symbols
 * were lost leaves a per-file hole the total-zero reactive check cannot see — the
 * file is skipped every run and never repopulates. This tightens the rule to per-file:
 * a code-file hash survives only if the previous graph actually holds ≥1 tree-sitter
 * symbol for that file; otherwise it is removed from the incremental baseline so the
 * file is treated as changed and re-parsed.
 *
 * Only tree-sitter-language files are considered — a prose/markdown hash has no code
 * symbols by definition and must not be forced through the tree-sitter walk. Returns
 * a fresh map; the caller's object is never mutated.
 *
 * @param previousHashes  fileHashes of the previous index (the incremental baseline).
 * @param previousGraph   the previous index's graph.
 * @param tsitterLangs    active tree-sitter languages (from getAvailableLanguages()).
 */
export function pruneDegenerateHashes(
  previousHashes: Record<string, string>,
  previousGraph: KnowledgeGraph,
  tsitterLangs: Language[],
): Record<string, string> {
  const langSet = new Set<string>(tsitterLangs);

  // Files the previous graph has at least one tree-sitter symbol for.
  const filesWithSymbols = new Set<string>();
  for (const node of previousGraph.nodes.values()) {
    if (langSet.has(node.language)) filesWithSymbols.add(node.file);
  }

  const pruned: Record<string, string> = {};
  for (const [file, hash] of Object.entries(previousHashes)) {
    const lang = getLanguageForFile(file);
    const isCodeFile = lang !== undefined && langSet.has(lang);
    // Drop only a CODE file that the previous graph has no symbols for; keep prose
    // hashes and any code file that is genuinely populated.
    if (isCodeFile && !filesWithSymbols.has(file)) continue;
    pruned[file] = hash;
  }
  return pruned;
}

/**
 * Reactive recovery decision (mechanism 1): should this build re-run once with full
 * (force) semantics to escape a degenerate code graph?
 *
 * Computed purely from the existing index stats and the final graph symbol count —
 * NO new file walk. Heal exactly when all hold:
 *  - the final graph has ZERO tree-sitter code symbols (the degenerate outcome);
 *  - at least one supported code file was discovered (parsed + skipped ≥ 1) — a
 *    docs-only repo is legitimately zero and must never heal;
 *  - the run was incremental — a forced full pass is already the recovery path, so a
 *    force run that lands at zero is a genuine grammar/parse failure, not the bug;
 *  - it has not already healed this run — recover at most once; a still-zero forced
 *    pass is accepted (with a warning) rather than looped.
 *
 * @param finalSymbols    tree-sitter code symbols in the final (post-carry-over) graph.
 * @param parsed          files freshly (re)analyzed this run (stats.files).
 * @param skipped         unchanged files skipped this run (stats.skipped).
 * @param incremental     true when the run used a previous index (not --force).
 * @param alreadyHealed   true once a heal has been attempted in this run.
 */
export function shouldReactiveHeal(args: {
  finalSymbols: number;
  parsed: number;
  skipped: number;
  incremental: boolean;
  alreadyHealed: boolean;
}): boolean {
  const codeFilesDiscovered = args.parsed + args.skipped;
  return (
    args.finalSymbols === 0 &&
    codeFilesDiscovered >= 1 &&
    args.incremental &&
    !args.alreadyHealed
  );
}

/**
 * Serve-startup reindex decision (C2, [#10]): should `serve` rebuild the index
 * before serving, given the index it just LOADED from disk?
 *
 * The pre-C2 gate reindexed only when no index existed or the commit moved — so a
 * loaded index that is DEGENERATE (zero tree-sitter symbols while code files are
 * present) but at the current commit passed the gate and was served dark, keeping
 * an install empty across every restart. This extends the startup decision to also
 * fire on that degenerate-loaded state, REUSING the C1 degenerate detector
 * `shouldReactiveHeal` — there is NO second detection implementation here.
 *
 * Returns true (serve must reindex) when ANY holds:
 *  - no index was loaded (absent) — preserves the prior "no index found" path;
 *  - the loaded index's commit ≠ the current commit (stale) — prior "index is stale";
 *  - the loaded index is degenerate per shouldReactiveHeal: zero tree-sitter symbols
 *    in the loaded graph WHILE ≥1 supported code file is present in its fileHashes.
 *
 * The degenerate check maps the loaded index onto shouldReactiveHeal's inputs:
 *  - finalSymbols  = tree-sitter symbols in the loaded graph (langSet filter);
 *  - parsed        = 0 (serve has not re-walked anything yet at startup);
 *  - skipped       = code files present in the loaded index (fileHashes, code-typed) —
 *                    the "code present" signal, so a docs-only index is legitimately
 *                    zero and never reindexes;
 *  - incremental   = true (a loaded index IS the incremental baseline — the exact
 *                    degenerate-incremental scenario the sticky-empty bug describes);
 *  - alreadyHealed = false (serve startup is the first attempt this run).
 *
 * Pure — no filesystem, no git. The caller (serveCommand) adapts its loaded
 * StoredIndex + git HEAD into these primitives and triggers a full reindex on true.
 *
 * @param existingGraph  the loaded index's graph, or null when no index exists.
 * @param fileHashes     the loaded index's fileHashes (relativePath → hash); {} when none.
 * @param indexedCommit  the commit the loaded index was built at, or null when none.
 * @param currentCommit  the project's current git HEAD.
 * @param tsitterLangs   active tree-sitter languages (from getAvailableLanguages()).
 */
export function serveNeedsReindex(args: {
  existingGraph: KnowledgeGraph | null;
  fileHashes: Record<string, string>;
  indexedCommit: string | null;
  currentCommit: string;
  tsitterLangs: Language[];
}): boolean {
  // No index loaded → reindex (prior "no index found").
  if (!args.existingGraph) return true;

  // Commit moved → reindex (prior "index is stale").
  if (args.indexedCommit !== args.currentCommit) return true;

  // Otherwise: reindex ONLY if the loaded index is degenerate. Detection is C1's
  // shouldReactiveHeal — the loaded graph's tree-sitter symbol count vs the code
  // files the index recorded; a docs-only index (no code-typed hashes) yields
  // skipped=0 and never heals.
  const langSet = new Set<string>(args.tsitterLangs);

  const loadedSymbols = [...args.existingGraph.nodes.values()].filter((n) =>
    langSet.has(n.language),
  ).length;

  let codeFilesPresent = 0;
  for (const file of Object.keys(args.fileHashes)) {
    const lang = getLanguageForFile(file);
    if (lang !== undefined && langSet.has(lang)) codeFilesPresent++;
  }

  return shouldReactiveHeal({
    finalSymbols: loadedSymbols,
    parsed: 0,
    skipped: codeFilesPresent,
    incremental: true,
    alreadyHealed: false,
  });
}

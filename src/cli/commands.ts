/**
 * CLI Commands
 *
 * Implementation of index, serve, status, clean commands.
 */

import { execSync, spawn } from 'node:child_process';
import { rmSync, existsSync, watch } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { KnowledgeGraph } from '../graph/graph.js';
import { buildCrossLanguageEdges, extractGoRoutes } from '../analyzers/cross-language.js';
import type { APIRoute } from '../analyzers/cross-language.js';
import { saveIndex, saveSearchIndex, saveEmbeddings, saveSearchText, loadIndex, loadEmbeddings, loadSearchText, loadAllRepos, defaultRepoName } from '../storage/store.js';
import { SqliteStore } from '../storage/sqlite.js';
import { detectV5Index, migrateV5ToV6, detectV6Index } from '../storage/migrate.js';
import { generateAgentsMd } from '../generators/agents-gen.js';
import type { IndexMeta } from '../storage/types.js';
import { startServer } from '../mcp/server.js';
import { startQueryDoorSafe, claimEndpoint } from '../server/endpoint.js';
import { setFulltextRanker } from '../mcp/find.js';
import { BM25Index } from '../search/bm25.js';
import { VectorStore } from '../search/vector-store.js';
import { generateEmbeddingText, shouldEmbed } from '../search/text-generator.js';
import { initEmbedder, embedBatch, disposeEmbedder, DEFAULT_CONFIG } from '../search/embedder.js';
import { analyzeTreeSitter, analyzeTreeSitterParallel } from '../analyzers/tree-sitter/index.js';
import { analyzeMarkdown, findMarkdownFiles } from '../analyzers/markdown.js';
import type { MarkdownAnalysisResult } from '../analyzers/markdown.js';
import { loadReinforceSidecar, applyRecency } from '../analyzers/prose-signals.js';
import type { AnalyzerWarning } from '../analyzers/types.js';
import { analyzeSource, findSourceFiles } from '../analyzers/source.js';
import { resolveDocEdges } from '../analyzers/doc-edges.js';
import { getAvailableLanguages } from '../analyzers/tree-sitter/index.js';
import { carryOverUnchangedTreeSitter, pruneDegenerateHashes, shouldReactiveHeal, serveNeedsReindex } from '../analyzers/tree-sitter/carryover.js';
import { detectCommunities } from '../graph/community.js';
import { NodeType, RelationshipType } from '../graph/types.js';
import { hashContent } from '../utils/hash.js';
import { ReconWatcher } from '../watcher/watcher.js';
import type { ProjectDir } from '../watcher/watcher.js';
import { loadConfig, mergeWithCLI } from '../config/config.js';

/**
 * Find project root by walking up to find go.mod.
 */
function findProjectRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  while (dir !== resolve(dir, '..')) {
    if (existsSync(join(dir, 'go.mod'))) return dir;
    dir = resolve(dir, '..');
  }
  // Fallback: use cwd
  return process.cwd();
}

/**
 * Get current git commit and branch.
 */
function getGitInfo(cwd: string): { commit: string; branch: string } {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf-8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
    return { commit, branch };
  } catch {
    return { commit: 'unknown', branch: 'unknown' };
  }
}

// ─── Shared prose ingestion ─────────────────────────────────────

/**
 * Ingest markdown prose into the graph and persist its searchText snapshot.
 * Shared by BOTH index paths (indexCommand + indexProject) so secondary repos
 * get the same Page/Section nodes + search-text.json as the primary one.
 *
 * @param walkRoot  directory walked for .md files (the repo being indexed)
 * @param saveRoot  project root the snapshot is saved under (the MAIN project)
 * @param repoName  repo subdir for the snapshot (undefined = legacy root)
 *
 * Returns the analysis result so each caller logs warnings/counts in its own
 * stdout/stderr style — indexProject must stay off stdout (it can run under
 * serve's stdio MCP channel).
 */
async function ingestProse(
  graph: KnowledgeGraph,
  walkRoot: string,
  saveRoot: string,
  ignore: string[],
  maxFileSize: number,
  repoName?: string,
): Promise<MarkdownAnalysisResult & { fileHashes: Record<string, string>; sourceWarnings: AnalyzerWarning[] }> {
  const files = findMarkdownFiles(walkRoot, ignore, maxFileSize);
  const mdResult = analyzeMarkdown(files);
  // Carry reinforce-recency onto prose Page nodes from the .wrxn/reinforce.json
  // sidecar (harvest-07 / D1). Keyed by wiki-root-relative path — IDENTICAL to
  // the key the kernel reinforce-stamp (harvest-08) writes. Fail-open: an absent
  // or malformed sidecar leaves pages without recency, serve unaffected. The
  // sidecar lives under walkRoot (the repo being indexed, whose pages' wiki-rel
  // paths it keys). Pure ingest — the decay-weight scorer (harvest-09) reads it.
  applyRecency(mdResult.nodes, loadReinforceSidecar(walkRoot));
  for (const node of mdResult.nodes) {
    graph.addNode(node);
  }
  for (const rel of mdResult.relationships) {
    graph.addRelationship(rel);
  }

  // Multi-format Source files (multiformat-distill-01): html/txt → full
  // searchable Source nodes; pdf/docx/pptx/xlsx → minimal nodes (path, no body).
  // Same seam as prose — their body is merged into the searchText snapshot below
  // so BM25 indexes it and embeddings (proseText) pick it up, with the body kept
  // OFF the graph node exactly like Page/Section.
  const sourceFiles = findSourceFiles(walkRoot, ignore, maxFileSize);
  const srcResult = analyzeSource(sourceFiles);
  for (const node of srcResult.nodes) {
    graph.addNode(node);
  }
  Object.assign(mdResult.searchText, srcResult.searchText);
  // Source skips are kept SEPARATE from markdown skips (returned as sourceWarnings)
  // so each caller reports them under a truthful banner — a skipped .json/.yaml is
  // not a "markdown file" (multiformat-distill-09).

  // Resolve doc→code DOCUMENTED_BY edges now that BOTH code (tree-sitter +
  // cross-language, added before this call) and the prose nodes above are in the
  // graph (recon-prose-analyzer-06). Unresolvable signals add no edge.
  for (const edge of resolveDocEdges(graph, mdResult.citations)) {
    graph.addRelationship(edge);
  }
  await saveSearchText(saveRoot, mdResult.searchText, repoName);

  // SHA-256 each .md by project-relative path, so the embedding step can skip
  // re-embedding prose whose file is unchanged (mirrors the tree-sitter hashes).
  const fileHashes: Record<string, string> = {};
  for (const f of files) fileHashes[f.path] = hashContent(f.content);
  // Text-native source files carry content → hash for incremental embedding
  // freshness (binary nodes have no content/searchText, so nothing to re-embed).
  for (const f of sourceFiles) {
    if (f.content !== undefined) fileHashes[f.path] = hashContent(f.content);
  }

  return { ...mdResult, fileHashes, sourceWarnings: srcResult.warnings };
}

// ─── indexProject: index an external directory ──────────────────

/**
 * Index an external project directory and save the result under
 * the main project's .recon-wrxn/repos/{repoName}/ directory.
 *
 * This enables multi-project support: the MCP server can serve
 * a merged knowledge graph from multiple codebases.
 */
export async function indexProject(
  projectDir: string,
  mainProjectRoot: string,
  repoName?: string,
): Promise<void> {
  const resolvedDir = resolve(projectDir);
  const name = repoName || basename(resolvedDir);

  if (!existsSync(resolvedDir)) {
    console.error(`[recon] Project directory not found: ${resolvedDir}`);
    return;
  }

  const startTime = performance.now();
  console.error(`[recon] Indexing external project: ${resolvedDir} (repo: ${name})...`);

  // Honor the external project's own .recon-wrxn.json ignore patterns
  const extConfig = loadConfig(resolvedDir);

  // Build graph
  const graph = new KnowledgeGraph();

  // Tree-sitter analysis (TS/TSX now flow through here like every other grammar)
  const tsitterLangs = getAvailableLanguages();
  let tsitterSymbols = 0;
  let tsitterFiles = 0;
  let tsitterHashes: Record<string, string> = {};
  if (tsitterLangs.length > 0) {
    const tsitterResult = analyzeTreeSitter(resolvedDir, undefined, extConfig.ignore, extConfig.maxFileSize);
    for (const node of tsitterResult.result.nodes) {
      graph.addNode(node);
    }
    for (const rel of tsitterResult.result.relationships) {
      graph.addRelationship(rel);
    }
    tsitterSymbols = tsitterResult.stats.symbols;
    tsitterFiles = tsitterResult.stats.files;
    tsitterHashes = tsitterResult.fileHashes;

    if (tsitterResult.warnings.length > 0) {
      console.error(`[recon] ${tsitterResult.warnings.length} tree-sitter file(s) skipped due to errors:`);
      for (const w of tsitterResult.warnings) {
        console.error(`  ${w.file}: ${w.reason}`);
      }
    }
  }

  // Cross-language analysis
  const existingNodeIds = new Set<string>();
  for (const [id] of graph.nodes) existingNodeIds.add(id);
  const crossLangResult = buildCrossLanguageEdges(resolvedDir, existingNodeIds);
  for (const node of crossLangResult.result.nodes) {
    graph.addNode(node);
  }
  for (const rel of crossLangResult.result.relationships) {
    graph.addRelationship(rel);
  }

  // Markdown / prose analysis — same ingest as the primary path (indexCommand),
  // so secondary repos get Page/Section nodes + a search-text.json snapshot too.
  // Saved under the MAIN project's repo dir; console.error (never stdout) since
  // indexProject can run inside serve's stdio auto-index.
  const mdResult = await ingestProse(graph, resolvedDir, mainProjectRoot, extConfig.ignore, extConfig.maxFileSize, name);
  if (mdResult.warnings.length > 0) {
    console.error(`[recon] ${mdResult.warnings.length} markdown file(s) skipped due to errors:`);
    for (const w of mdResult.warnings) {
      console.error(`  ${w.file}: ${w.reason}`);
    }
  }
  if (mdResult.sourceWarnings.length > 0) {
    console.error(`[recon] ${mdResult.sourceWarnings.length} source file(s) skipped due to errors:`);
    for (const w of mdResult.sourceWarnings) {
      console.error(`  ${w.file}: ${w.reason}`);
    }
  }
  console.error(`[recon] Prose: ${mdResult.nodes.length} nodes, ${mdResult.relationships.length} edges`);

  // Git info
  const git = getGitInfo(resolvedDir);
  const elapsed = Math.round(performance.now() - startTime);

  const meta: IndexMeta = {
    version: 1,
    indexedAt: new Date().toISOString(),
    gitCommit: git.commit,
    gitBranch: git.branch,
    stats: {
      tsModules: 0,
      tsSymbols: 0,
      treeSitterFiles: tsitterFiles,
      treeSitterSymbols: tsitterSymbols,
      relationships: graph.relationshipCount,
      indexTimeMs: elapsed,
    },
    fileHashes: { ...tsitterHashes },
    apiRoutes: crossLangResult.routes.map(r => ({
      method: r.method,
      pattern: r.pattern,
      handler: r.handler,
    })),
  };

  // Community detection
  detectCommunities(graph);

  // Stamp repo name on all nodes
  for (const node of graph.nodes.values()) {
    node.repo = name;
  }

  // Save under MAIN project's .recon-wrxn/repos/{name}/
  await saveIndex(mainProjectRoot, graph, meta, name);

  // Build and save BM25 search index
  const searchIndex = BM25Index.buildFromGraph(graph);
  await saveSearchIndex(mainProjectRoot, searchIndex, name);

  console.error(
    `[recon] External project '${name}': ${graph.nodeCount} nodes, ` +
    `${graph.relationshipCount} rels, ${elapsed}ms`,
  );
}

// ??? index command ???????????????????????????????????????????????

/**
 * Decide embedding behavior from the tri-state --embeddings / --no-embeddings flag.
 *   undefined (no flag) → don't embed yet, but AUTO-DETECT @huggingface/transformers
 *   true   (--embeddings)    → embed, no auto-detect needed
 *   false  (--no-embeddings) → DO NOT embed and SUPPRESS auto-detect (the load-bearing skip;
 *                              keeps a grown-graph reindex fast for graph.json-only consumers)
 * Pure + exported so the suppression contract is unit-testable independent of the index pipeline.
 */
export function embeddingDecision(flag: boolean | undefined): { embed: boolean; autoDetect: boolean } {
  if (flag === true) return { embed: true, autoDetect: false };
  if (flag === false) return { embed: false, autoDetect: false };
  return { embed: false, autoDetect: true };
}

/** One embeddable node: its id, type (for scoped search), source file (for freshness), embedding text. */
export interface EmbeddingWorkItem {
  id: string;
  type: NodeType;
  file: string;
  text: string;
}

/**
 * SHA-256 incremental freshness for embeddings. Re-embedding is the expensive
 * step, so split the embeddable nodes into:
 *   - carryOver: source file's hash is unchanged AND the node already has a vector
 *                in the previous store → reuse that vector, no model call.
 *   - reEmbed:   new node, changed file, or no previous vector → must embed.
 * Pure + exported so the "only changed .md are re-embedded" contract is unit-testable
 * without loading the embedding model. Reuses the same fileHashes recon already
 * computes for incremental indexing (now including .md, see ingestProse).
 */
export function partitionEmbeddingWork(
  items: EmbeddingWorkItem[],
  previousStore: VectorStore | null,
  previousHashes: Record<string, string> | undefined,
  currentHashes: Record<string, string>,
): { carryOver: EmbeddingWorkItem[]; reEmbed: EmbeddingWorkItem[] } {
  const carryOver: EmbeddingWorkItem[] = [];
  const reEmbed: EmbeddingWorkItem[] = [];

  for (const item of items) {
    const prevHash = previousHashes?.[item.file];
    const fileUnchanged = prevHash !== undefined && prevHash === currentHashes[item.file];
    if (previousStore && fileUnchanged && previousStore.has(item.id)) {
      carryOver.push(item);
    } else {
      reEmbed.push(item);
    }
  }

  return { carryOver, reEmbed };
}

/**
 * The embedder functions embedGraph depends on. Injectable so the embed pass is
 * unit-testable with a deterministic fake — the real transformer model is an
 * optional dependency and a multi-second load. Defaults to the real module fns.
 */
export interface EmbedderDeps {
  initEmbedder: typeof initEmbedder;
  embedBatch: typeof embedBatch;
  disposeEmbedder: typeof disposeEmbedder;
}

const REAL_EMBEDDER: EmbedderDeps = { initEmbedder, embedBatch, disposeEmbedder };

/**
 * Embed a graph's embeddable nodes into a VectorStore and persist embeddings.json.
 *
 * Factored out of indexCommand (slice C) so `index --embeddings-only` and the
 * serve-time background embed reuse the SAME pass — incremental SHA-256 freshness
 * included. It writes ONLY embeddings.json (via saveEmbeddings); it never touches
 * graph.json / search-text.json, so a background embed can run without racing
 * serve's watcher (which rewrites graph.json non-atomically).
 *
 * Freshness inputs are passed in (not re-derived) so behavior is identical for
 * both callers: indexCommand compares the OLD index hashes vs the freshly-walked
 * NEW hashes (and honors --force); the embed-only path has no walk, so the stored
 * hashes serve as both previous and current → every already-embedded unchanged
 * node carries over and only the rest is embedded.
 *
 * Returns the vector counts when something was written, or null when there were
 * no embeddable nodes (embeddings.json left untouched).
 */
export async function embedGraph(
  projectRoot: string,
  graph: KnowledgeGraph,
  searchText: Record<string, string> | null,
  repoName: string | undefined,
  freshness: { force?: boolean; previousHashes: Record<string, string> | undefined; currentHashes: Record<string, string> },
  deps: EmbedderDeps = REAL_EMBEDDER,
): Promise<{ size: number; reused: number; embedded: number } | null> {
  // Collect embeddable nodes (code + prose). Prose carries its body via the
  // searchText snapshot, which is kept OFF the graph node — pass it so the
  // prose meaning, not a synthetic signature, is what gets embedded. shouldEmbed
  // (not isEmbeddable) so a BINARY Source node (filename only) is skipped.
  const proseText = searchText ?? {};
  const embeddable: EmbeddingWorkItem[] = [];
  for (const node of graph.nodes.values()) {
    if (shouldEmbed(node, proseText[node.id])) {
      embeddable.push({
        id: node.id,
        type: node.type,
        file: node.file,
        text: generateEmbeddingText(node, proseText[node.id]),
      });
    }
  }

  // SHA-256 incremental freshness: carry unchanged nodes' vectors forward and
  // re-embed only changed/new ones.
  const previousStore = freshness.force ? null : await loadEmbeddings(projectRoot, repoName);
  const { carryOver, reEmbed } = partitionEmbeddingWork(
    embeddable, previousStore, freshness.previousHashes, freshness.currentHashes,
  );

  const vectorStore = new VectorStore(DEFAULT_CONFIG.dimensions);
  for (const item of carryOver) {
    const vec = previousStore!.get(item.id);
    if (vec) vectorStore.add(item.id, vec, item.type);
    else reEmbed.push(item); // defensive: vector vanished → re-embed it
  }

  if (reEmbed.length > 0) {
    await deps.initEmbedder();
    const embeddings = await deps.embedBatch(reEmbed.map(n => n.text));
    for (let i = 0; i < reEmbed.length; i++) {
      vectorStore.add(reEmbed[i].id, embeddings[i], reEmbed[i].type);
    }
    await deps.disposeEmbedder();
  }

  if (vectorStore.size > 0) {
    await saveEmbeddings(projectRoot, vectorStore, repoName);
    return { size: vectorStore.size, reused: carryOver.length, embedded: reEmbed.length };
  }
  return null;
}

export async function indexCommand(options: { force?: boolean; repo?: string; embeddings?: boolean; embeddingsOnly?: boolean; _healed?: boolean }): Promise<void> {
  const startTime = performance.now();
  const projectRoot = findProjectRoot();
  const repoName = options.repo;

  // --embeddings-only: embed the ALREADY-STORED index, no re-walk, no graph.json
  // rewrite. This is the detached child serve spawns to bring hybrid online.
  if (options.embeddingsOnly) {
    await indexEmbeddingsOnly(projectRoot, repoName);
    return;
  }

  console.log(`[recon] Indexing from ${projectRoot}${repoName ? ` (repo: ${repoName})` : ''}...`);

  // Load .recon-wrxn.json so ignore patterns (e.g. worktree subtrees) prune the walk
  const config = loadConfig(projectRoot);

  // Load previous index for incremental comparison
  const previousIndex = options.force ? null : await loadIndex(projectRoot, repoName);

  if (previousIndex && !options.force) {
    console.log('[recon] Previous index found ??using incremental mode.');
  }

  // Build graph
  const graph = new KnowledgeGraph();

  // Tree-sitter analysis (TS/TSX now flow through here like every other grammar)
  const tsitterLangs = getAvailableLanguages();
  let tsitterSymbols = 0;
  let tsitterFiles = 0;
  let tsitterSkipped = 0;
  let tsitterHashes: Record<string, string> = {};

  // Preventive carry-over correctness (C1 mechanism 2): an unchanged code file whose
  // PREVIOUS graph holds zero tree-sitter symbols would be skipped (hash match) and then
  // carried empty forever — a per-file degenerate hole the total-zero reactive check can't
  // see. Drop those files' hashes from the incremental baseline so the analyzer re-parses
  // them instead of skipping. Computed from the previous graph + hashes — no new walk.
  const previousHashes =
    previousIndex && tsitterLangs.length > 0
      ? pruneDegenerateHashes(previousIndex.meta.fileHashes ?? {}, previousIndex.graph, tsitterLangs)
      : previousIndex?.meta.fileHashes;

  if (tsitterLangs.length > 0) {
    console.log(`[recon] Analyzing with tree-sitter (${tsitterLangs.join(', ')})...`);
    const tsitterResult = await analyzeTreeSitterParallel(projectRoot, previousHashes, config.ignore, config.maxFileSize);

    for (const node of tsitterResult.result.nodes) {
      graph.addNode(node);
    }
    for (const rel of tsitterResult.result.relationships) {
      graph.addRelationship(rel);
    }

    tsitterSymbols = tsitterResult.stats.symbols;
    tsitterFiles = tsitterResult.stats.files;
    tsitterSkipped = tsitterResult.stats.skipped;
    tsitterHashes = tsitterResult.fileHashes;

    if (tsitterResult.stats.files > 0) {
      const langBreakdown = Object.entries(tsitterResult.stats.languages)
        .map(([l, c]) => `${l}: ${c}`)
        .join(', ');
      console.log(
        `[recon] Tree-sitter: ${tsitterResult.stats.files} files, ` +
        `${tsitterResult.stats.symbols} symbols (${langBreakdown})`,
      );
    }

    if (tsitterResult.warnings.length > 0) {
      console.log(`[recon] ${tsitterResult.warnings.length} tree-sitter file(s) skipped due to errors:`);
      for (const w of tsitterResult.warnings) {
        console.log(`  ${w.file}: ${w.reason}`);
      }
    }

    // If incremental, carry over UNCHANGED tree-sitter symbols from the previous index.
    // Without this, an all-tree-sitter repo (tsModules=0) with no changes produces zero
    // fresh tree-sitter nodes and the graph collapses to empty — the long-standing
    // "plain `recon index` empties the graph, only --force works" bug. The TS carry-over
    // above is TypeScript-only, so tree-sitter languages had no equivalent. See
    // carryOverUnchangedTreeSitter for the exact carry/drop rules.
    if (previousIndex && tsitterResult.stats.skipped > 0) {
      carryOverUnchangedTreeSitter(
        graph,
        previousIndex.graph,
        tsitterLangs,
        tsitterResult.analyzedFiles,
        tsitterHashes,
      );
    }
  }

  // Reactive recovery (C1 mechanism 1): if this incremental build ended with a code
  // graph that is empty of tree-sitter symbols WHILE supported code files exist, the
  // index has gone degenerate — re-run ONCE with full (force) semantics, the proven
  // recovery path, instead of persisting an empty graph. Detection is from the index
  // stats (parsed + skipped) and the final graph symbol count — no new walk. Heal at
  // most once per run; a forced pass that is still zero with code present is a genuine
  // grammar/parse failure (not the sticky bug) → warn and accept, never loop.
  const langSet = new Set<string>(tsitterLangs);
  const finalTreeSitterSymbols = [...graph.nodes.values()].filter((n) =>
    langSet.has(n.language),
  ).length;

  if (
    shouldReactiveHeal({
      finalSymbols: finalTreeSitterSymbols,
      parsed: tsitterFiles,
      skipped: tsitterSkipped,
      incremental: Boolean(previousIndex) && !options.force,
      alreadyHealed: Boolean(options._healed),
    })
  ) {
    console.log(
      '[recon] self-heal: code files present but graph has zero tree-sitter symbols ' +
        '— re-indexing with --force.',
    );
    await indexCommand({ ...options, force: true, _healed: true });
    return;
  }

  if (options._healed && finalTreeSitterSymbols === 0 && tsitterFiles + tsitterSkipped >= 1) {
    // Forced full pass still empty with code present: a genuine grammar/parse failure,
    // not the sticky-empty incremental bug. Accept (do NOT loop) and surface the reason.
    // Logged on stdout to share the self-heal narrative channel — this is an accepted
    // outcome the operator should see, not a process error.
    console.log(
      '[recon] warning: forced re-index still produced zero tree-sitter symbols with ' +
        'code files present — accepting as a genuine grammar/parse failure (not retrying).',
    );
  }

  // Cross-language analysis: link TS API calls to Go handlers
  console.log('[recon] Analyzing cross-language API links...');
  const existingNodeIds = new Set<string>();
  for (const [id] of graph.nodes) existingNodeIds.add(id);

  const crossLangResult = buildCrossLanguageEdges(projectRoot, existingNodeIds);
  for (const node of crossLangResult.result.nodes) {
    graph.addNode(node);
  }
  for (const rel of crossLangResult.result.relationships) {
    graph.addRelationship(rel);
  }
  console.log(
    `[recon] Found ${crossLangResult.routes.length} API routes, ` +
    `${crossLangResult.result.relationships.length} cross-language edges`,
  );

  // Markdown / prose analysis: ingest .md as Page/Section nodes (tree-sitter
  // rejects .md, so the analyzer has its own walker). The body text is kept OFF
  // the graph node and carried in the searchText snapshot persisted by ingestProse
  // (shared with indexProject so secondary repos ingest the same way).
  console.log('[recon] Analyzing markdown prose...');
  const mdResult = await ingestProse(graph, projectRoot, projectRoot, config.ignore, config.maxFileSize, repoName);
  console.log(`[recon] Prose: ${mdResult.nodes.length} nodes, ${mdResult.relationships.length} edges`);
  if (mdResult.warnings.length > 0) {
    console.log(`[recon] ${mdResult.warnings.length} markdown file(s) skipped due to errors:`);
    for (const w of mdResult.warnings) {
      console.log(`  ${w.file}: ${w.reason}`);
    }
  }
  if (mdResult.sourceWarnings.length > 0) {
    console.log(`[recon] ${mdResult.sourceWarnings.length} source file(s) skipped due to errors:`);
    for (const w of mdResult.sourceWarnings) {
      console.log(`  ${w.file}: ${w.reason}`);
    }
  }

  // Git info
  const git = getGitInfo(projectRoot);

  // Count stats
  const elapsed = Math.round(performance.now() - startTime);

  const meta: IndexMeta = {
    version: 1,
    indexedAt: new Date().toISOString(),
    gitCommit: git.commit,
    gitBranch: git.branch,
    stats: {
      tsModules: 0,
      tsSymbols: 0,
      treeSitterFiles: tsitterFiles,
      treeSitterSymbols: tsitterSymbols,
      relationships: graph.relationshipCount,
      indexTimeMs: elapsed,
    },
    fileHashes: { ...tsitterHashes, ...mdResult.fileHashes },
    apiRoutes: crossLangResult.routes.map(r => ({
      method: r.method,
      pattern: r.pattern,
      handler: r.handler,
    })),
  };

  // Community detection
  console.log('[recon] Detecting communities...');
  const communityStats = detectCommunities(graph);
  console.log(
    `[recon] Communities: ${communityStats.communityCount} clusters in ${communityStats.iterations} iterations` +
    (communityStats.largestCommunity.size > 0
      ? ` (largest: ${communityStats.largestCommunity.label} with ${communityStats.largestCommunity.size} symbols)`
      : ''),
  );

  // Save
  // Stamp repo name on all nodes if multi-repo
  if (repoName) {
    for (const node of graph.nodes.values()) {
      node.repo = repoName;
    }
  }

  await saveIndex(projectRoot, graph, meta, repoName);

  // Also save to SQLite store
  const store = new SqliteStore(projectRoot);
  store.insertNodes([...graph.nodes.values()]);
  store.insertRelationships([...graph.relationships.values()]);
  store.setMeta('gitCommit', meta.gitCommit);
  store.setMeta('indexedAt', meta.indexedAt);
  store.setMeta('schemaVersion', '6');
  if (meta.fileHashes) store.setMeta('fileHashes', JSON.stringify(meta.fileHashes));
  store.close();

  // Generate AGENTS.md
  const agentsMd = generateAgentsMd(graph, repoName);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const reconDir = join(projectRoot, '.recon-wrxn');
  mkdirSync(reconDir, { recursive: true });
  writeFileSync(join(reconDir, 'AGENTS.md'), agentsMd);
  console.log(`[recon] Generated .recon-wrxn/AGENTS.md`);

  // Build and save BM25 search index
  console.log('[recon] Building search index...');
  const searchIndex = BM25Index.buildFromGraph(graph);
  await saveSearchIndex(projectRoot, searchIndex, repoName);
  console.log(`[recon] Search index: ${searchIndex.documentCount} documents`);

  // Embedding pipeline (optional). The 3-state flag decision is extracted to embeddingDecision()
  // (pure + unit-tested) so the load-bearing --no-embeddings suppression can't silently regress.
  const { embed: decidedEmbed, autoDetect } = embeddingDecision(options.embeddings);
  let doEmbeddings = decidedEmbed;

  if (autoDetect) {
    // Auto-detect: if @huggingface/transformers is installed, enable embeddings
    try {
      await (Function('return import("@huggingface/transformers")')() as Promise<any>);
      doEmbeddings = true;
      console.log('[recon] Found @huggingface/transformers — enabling semantic search.');
    } catch {
      // Not installed — stay BM25 only
    }
  }

  if (doEmbeddings) {
    console.log('[recon] Generating embeddings...');
    try {
      // The embed pass is factored into embedGraph (slice C) so `index
      // --embeddings-only` and the serve-time background embed reuse it. Prose
      // carries its body via the searchText snapshot (kept OFF the graph node).
      // Freshness compares the OLD index hashes vs the freshly-walked NEW hashes.
      const result = await embedGraph(projectRoot, graph, mdResult.searchText, repoName, {
        force: options.force,
        previousHashes,
        currentHashes: meta.fileHashes,
      });
      if (result) {
        console.log(
          `[recon] Embeddings: ${result.size} vectors ` +
          `(${result.reused} reused, ${result.embedded} re-embedded, ${DEFAULT_CONFIG.dimensions}d)`,
        );
      }
    } catch (err) {
      console.error(`[recon] Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[recon] Continuing without embeddings. Install @huggingface/transformers for semantic search.');
    }
  }

  const summary: string[] = [];
  if (tsitterSymbols > 0) {
    summary.push(`${tsitterFiles} tree-sitter files`, `${tsitterSymbols} tree-sitter symbols`);
  }
  summary.push(`${graph.relationshipCount} relationships in ${elapsed}ms`);
  console.log(`[recon] Indexed ${summary.join(', ')}`);
  console.log(`[recon] Saved to ${join(projectRoot, '.recon-wrxn/')}`);
}



// ??? serve command ???????????????????????????????????????????????

/**
 * Embed-only path: regenerate embeddings.json from an ALREADY-STORED index,
 * WITHOUT re-walking the repo and WITHOUT rewriting graph.json / search-text.json.
 *
 * This is what `serve` spawns as a detached child to bring hybrid search online
 * mid-session: graph.json is left untouched so the child can never race serve's
 * watcher, which also writes graph.json (non-atomically). With no walk, the stored
 * file hashes are both previous and current, so every already-embedded unchanged
 * node carries over and only the missing/changed ones are embedded.
 *
 * projectRoot is an argument (not derived) so it is unit-testable without a cwd
 * dependency; the CLI passes findProjectRoot(). The embedder is injectable for
 * the same reason embedGraph's is — fast, model-free tests.
 */
export async function indexEmbeddingsOnly(
  projectRoot: string,
  repoName?: string,
  deps: EmbedderDeps = REAL_EMBEDDER,
): Promise<void> {
  const stored = await loadIndex(projectRoot, repoName);
  if (!stored) {
    console.error(`[recon] No index found${repoName ? ` for repo '${repoName}'` : ''}. Run 'recon index' first.`);
    return;
  }

  const searchText = await loadSearchText(projectRoot, repoName);
  const hashes = stored.meta.fileHashes ?? {};

  try {
    const result = await embedGraph(
      projectRoot, stored.graph, searchText, repoName,
      { previousHashes: hashes, currentHashes: hashes },
      deps,
    );
    if (result) {
      console.log(
        `[recon] Embeddings: ${result.size} vectors ` +
        `(${result.reused} reused, ${result.embedded} re-embedded, ${DEFAULT_CONFIG.dimensions}d)`,
      );
    } else {
      console.log('[recon] No embeddable nodes — embeddings.json unchanged.');
    }
  } catch (err) {
    console.error(`[recon] Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Decide whether serve should spawn a background embed. True only when embeddings
 * are enabled (config.serveEmbed) AND the on-disk store is absent (size null) or
 * incomplete (fewer vectors than embeddable graph nodes) — i.e. only-when-stale.
 * Pure + exported so the contract is unit-testable independent of serve.
 */
export function shouldServeEmbed(opts: {
  serveEmbed: boolean;
  vectorStoreSize: number | null;
  embeddableCount: number;
}): boolean {
  return opts.serveEmbed && (opts.vectorStoreSize == null || opts.vectorStoreSize < opts.embeddableCount);
}

/**
 * Count the graph nodes a background embed would ACTUALLY embed — using the same
 * `shouldEmbed` predicate as `embedGraph`, NOT `isEmbeddable`. The two diverge on
 * binary Source nodes (pdf/docx/…): `isEmbeddable` counts them, but `embedGraph`
 * skips them (no body). Counting with `isEmbeddable` kept `shouldServeEmbed`
 * permanently true on any binary-bearing corpus → a stray embed child + reload every
 * serve. Pass the persisted searchText so a text-native Source (non-empty body) is
 * still counted. Pure + exported so the count contract is unit-testable.
 */
export function countEmbeddable(graph: KnowledgeGraph, searchText: Record<string, string> | null): number {
  let n = 0;
  for (const node of graph.nodes.values()) {
    if (shouldEmbed(node, searchText?.[node.id])) n++;
  }
  return n;
}

export async function serveCommand(options?: { repo?: string; http?: boolean; port?: number; noIndex?: boolean; noWatch?: boolean; projects?: string[]; serveEmbed?: boolean }): Promise<void> {
  const projectRoot = findProjectRoot();
  const repoName = options?.repo;

  // Check for v5→v6 migration
  if (detectV5Index(projectRoot) && !detectV6Index(projectRoot)) {
    console.log('Migrating v5 index to v6 (SQLite)...');
    const migStore = await migrateV5ToV6(projectRoot);
    migStore.close();
    console.log('Migration complete.');
  }

  // Load .recon-wrxn.json and merge with CLI flags
  const fileConfig = loadConfig(projectRoot);
  const config = mergeWithCLI(fileConfig, options || {});

  // Use config values (CLI overrides already applied)
  const projects = config.projects;
  // Auto-index: check if index needs (re)building
  if (!options?.noIndex) {
    const existing = await loadIndex(projectRoot, repoName);
    const git = getGitInfo(projectRoot);
    // Reindex on startup when the index is absent, stale (commit moved), OR
    // DEGENERATE — a loaded index with zero tree-sitter symbols while code files
    // are present. The pre-C2 gate (!existing || commit mismatch) served a
    // degenerate-but-current index dark, keeping an install empty across restarts.
    // serveNeedsReindex REUSES C1's shouldReactiveHeal detector to catch it ([#10]).
    const tsitterLangs = getAvailableLanguages();
    const needsIndex = serveNeedsReindex({
      existingGraph: existing?.graph ?? null,
      fileHashes: existing?.meta.fileHashes ?? {},
      indexedCommit: existing?.meta.gitCommit ?? null,
      currentCommit: git.commit,
      tsitterLangs,
    });

    if (needsIndex) {
      const reason = !existing
        ? 'no index found'
        : existing.meta.gitCommit !== git.commit
          ? 'index is stale'
          : 'loaded index is degenerate (zero code symbols, code present)';
      console.error(`[recon] Auto-indexing (${reason})...`);
      // embeddings:false — the serve auto-index must NOT regenerate embeddings.
      // Embedding generation re-embeds the WHOLE graph synchronously, blocking serve
      // startup by ~2min on a large graph. Hybrid retrieval IS now wired (slice 04):
      // recon_find → handleFind → executeFindHybrid consumes the vectorStore and fuses
      // BM25 ⊕ prose-scoped vectors via RRF. But the serve auto-index deliberately skips
      // the embed pass to keep startup fast — so hybrid stays DORMANT (executeFindHybrid's
      // built-in fallback degrades to pure BM25 when no vectors are present) until an
      // explicit `recon index --embeddings` writes embeddings.json. A detached/non-blocking
      // startup embed + stale-vector guard is the BL-038 follow-on (blocked on the embedder
      // module-singleton lifecycle, embedder.ts `_pipeline`).
      await indexCommand({ force: !existing, repo: repoName, embeddings: false });
    }

    // Auto-index external projects
    if (projects.length > 0) {
      for (const projectDir of projects) {
        const resolvedDir = resolve(projectDir);
        const extRepoName = basename(resolvedDir).toLowerCase();
        const extExisting = await loadIndex(projectRoot, extRepoName);
        const extGit = getGitInfo(resolvedDir);
        const extNeedsIndex = !extExisting || extExisting.meta.gitCommit !== extGit.commit;

        if (extNeedsIndex) {
          const reason = !extExisting ? 'no index found' : 'index is stale';
          console.error(`[recon] Auto-indexing external project '${extRepoName}' (${reason})...`);
          await indexProject(resolvedDir, projectRoot, extRepoName);
        } else {
          console.error(`[recon] External project '${extRepoName}' index is current.`);
        }
      }
    }
  }

  let graph: KnowledgeGraph;
  let vectorStore: VectorStore | null = null;
  // The indexed short commit the freshness watermark ([#9]) compares against. It is
  // projectRoot's own indexed commit: the loaded repo's in single-repo mode, the root
  // repo's in merged mode. Passed to the serve transports, which compute the live dirty
  // count from git per answer. Undefined → no footer (graceful).
  let indexedCommit: string | undefined;

  if (repoName) {
    // Load specific repo
    const stored = await loadIndex(projectRoot, repoName);
    if (!stored) {
      console.error(`[recon] No index found for repo '${repoName}'. Run 'npx recon-wrxn index --repo ${repoName}' first.`);
      process.exit(1);
    }
    graph = stored.graph;
    indexedCommit = stored.meta.gitCommit;
    vectorStore = await loadEmbeddings(projectRoot, repoName);
    console.error(`[recon] Loaded repo '${repoName}': ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships`);
  } else {
    // Try loading all repos (merged), fall back to legacy single index
    const allRepos = await loadAllRepos(projectRoot);
    if (allRepos) {
      graph = allRepos.graph;
      // The freshness base is projectRoot's OWN indexed commit — the root repo in the
      // merged set (its name = basename(projectRoot)). Absent if the root isn't indexed.
      const rootName = defaultRepoName(projectRoot);
      indexedCommit = allRepos.repos.find(r => r.name === rootName)?.meta.gitCommit;
      const repoNames = allRepos.repos.map(r => r.name).join(', ');
      console.error(`[recon] Loaded ${allRepos.repos.length} repo(s) [${repoNames}]: ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships`);
    } else {
      const stored = await loadIndex(projectRoot);
      if (!stored) {
        console.error("[recon] No index found. Run 'npx recon-wrxn index' first.");
        process.exit(1);
      }
      graph = stored.graph;
      indexedCommit = stored.meta.gitCommit;
      console.error(`[recon] Loaded index: ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships`);
    }
    vectorStore = await loadEmbeddings(projectRoot, repoName);
  }

  // Load the prose searchText snapshot into memory — the persisted lexical input
  // for prose retrieval (search-text.json: nodeId → heading+body).
  const searchText = await loadSearchText(projectRoot, repoName);
  if (searchText) {
    console.error(`[recon] Loaded ${Object.keys(searchText).length} prose searchText entries`);
  }

  // Build the live fulltext ranker: an in-memory BM25 index over the graph (code
  // nodes by name/file/package) + the prose searchText (Page/Section by body). Per
  // ADR 0002 it is DERIVED on serve and never persisted — the cheap index is
  // rebuilt, only its inputs (graph.json + search-text.json) are stored. Installed
  // behind the FulltextRanker interface so recon_find → executeFind ranks prose
  // body without touching the MCP handler.
  const fulltextRanker = BM25Index.buildFromGraph(graph, searchText ?? undefined);
  setFulltextRanker(fulltextRanker);
  console.error(`[recon] BM25 fulltext ranker ready (${fulltextRanker.documentCount} docs, in-memory)`);

  if (vectorStore) {
    console.error(`[recon] Loaded ${vectorStore.size} embeddings (${vectorStore.dimensions}d)`);
    // Try to init embedder for query-time hybrid search
    try {
      await initEmbedder();
      console.error('[recon] Embedder ready — hybrid search enabled.');
    } catch {
      console.error('[recon] Embedder not available — BM25-only search. Install @huggingface/transformers for hybrid.');
    }
  }

  // Start file watcher for live re-indexing
  if (config.watch) {
    const watchDirs: ProjectDir[] = [
      { dir: projectRoot, repoName: basename(projectRoot).toLowerCase() },
    ];
    for (const dir of projects) {
      watchDirs.push({ dir: resolve(dir), repoName: basename(resolve(dir)).toLowerCase() });
    }
    // onChange: the live BM25 ranker is built ONCE above, so recon_find goes
    // stale after a watched `.md`/source edit until restart. Rebuild it from the
    // SAME in-place-mutated graph + the reloaded searchText snapshot whenever the
    // watcher applies a file event — no restart. The event debounce throttles how
    // often a full rebuild runs. (Vector/embedding freshness is slice C.)
    const watcher = new ReconWatcher(
      graph, watchDirs, config.watchDebounce, config.ignore, projectRoot, config.maxFileSize, undefined,
      async () => {
        const st = await loadSearchText(projectRoot, repoName);
        setFulltextRanker(BM25Index.buildFromGraph(graph, st ?? undefined));
      },
    );
    watcher.start();
  }

  // ─── Background embed: bring hybrid search ONLINE mid-session ───
  // The serve auto-index runs with embeddings:false (a full embed blocks startup
  // by ~2min). Instead, when embeddings are absent/incomplete, spawn a DETACHED
  // child running `index --embeddings-only` (writes ONLY embeddings.json — never
  // graph.json, so it cannot race the watcher above). When the child lands
  // embeddings.json we hot-swap the live store + init the query embedder, with NO
  // restart. liveStore is what the MCP handler resolves per request (getter below).
  let liveStore = vectorStore;

  // Count with the SAME predicate the child embed uses (shouldEmbed) — isEmbeddable
  // over-counts binary Source nodes the embed skips, which kept shouldServeEmbed
  // permanently true (a stray embed child + reload on every serve). Multi-repo
  // (external projects) is out of scope here: the child embeds root-only, so a merged
  // count never converges — deferred to slice 09.
  const embeddableCount = countEmbeddable(graph, searchText);
  const singleRepo = projects.length === 0;

  if (singleRepo && shouldServeEmbed({ serveEmbed: config.serveEmbed, vectorStoreSize: vectorStore?.size ?? null, embeddableCount })) {
    // Detached + unref'd child. process.argv[1] is this CLI entrypoint; cwd=projectRoot
    // so the child's findProjectRoot resolves the same install. Wrapped so a spawn
    // failure (a sync throw, or an async 'error' event: EMFILE/ENOMEM/…) leaves serve
    // BM25-only and never crashes it.
    try {
      const child = spawn(
        process.execPath,
        [process.argv[1], 'index', '--embeddings-only', ...(repoName ? ['--repo', repoName] : [])],
        { cwd: projectRoot, detached: true, stdio: 'ignore' },
      );
      child.on('error', () => { /* async spawn failure → stay BM25-only */ });
      child.unref();
      console.error('[recon] Background embed started — hybrid activates mid-session when it completes.');
    } catch {
      // Synchronous spawn throw → stay BM25-only.
    }

    // Watch the install dir for embeddings.json landing; debounce ~750ms so a
    // non-atomic write settles before we read it. The watch only RELOADS — it
    // never re-spawns — and any failure leaves serve BM25-only (never crashes).
    const embedDir = repoName
      ? join(projectRoot, '.recon-wrxn', 'repos', repoName)
      : join(projectRoot, '.recon-wrxn');
    try {
      let settle: ReturnType<typeof setTimeout> | null = null;
      watch(embedDir, (_event, filename) => {
        if (filename !== 'embeddings.json') return;
        if (settle) clearTimeout(settle);
        settle = setTimeout(async () => {
          try {
            const reloaded = await loadEmbeddings(projectRoot, repoName);
            if (reloaded && reloaded.size > 0) {
              await initEmbedder();
              liveStore = reloaded;
              console.error(`[recon] Embeddings updated — hybrid search now active (${reloaded.size} vectors).`);
            }
          } catch {
            // Reload/embedder init failed → stay BM25-only.
          }
        }, 750);
      });
    } catch {
      // Watch unavailable (dir missing / platform) → no live swap; serve runs as-is.
    }
  }

  if (config.http || options?.http) {
    // The HTTP door reads the store through the SAME live getter as stdio
    // (() => liveStore), so a POST to the find endpoint sees the mid-session embedding
    // hot-swap above — not a stale by-value snapshot (recon-brain-recall-01).
    const { startHttpServer } = await import('../server/http.js');
    const port = options?.port || config.port;
    await startHttpServer({ port, graph, projectRoot, vectorStore: () => liveStore, indexedCommit });
    // Keep process alive
    await new Promise(() => { });
  } else {
    // Concurrent HTTP query door (recon-brain-recall-02, ADR 0003): in stdio mode,
    // if the serveHttp gate is on, ALSO bind the read-only find app on 127.0.0.1 on
    // an OS-assigned port and announce {pid,port} in .recon-wrxn/serve-endpoint.json,
    // so a short-lived client (the kernel recall hook) can reach this one warm index
    // without a second cold serve. Both transports run in this single process; the
    // door reads the SAME live store getter as stdio. Default off → serve unchanged.
    // Fail-open: a door bind/FS error must not kill serve before stdio starts.
    const door = await startQueryDoorSafe({
      serveHttp: config.serveHttp,
      reconDir: join(projectRoot, '.recon-wrxn'),
      graph,
      projectRoot,
      vectorStore: () => liveStore,
      indexedCommit,
    });
    if (door) {
      // Self-heal heartbeat (recon-wrxn#4): co-located serves share ONE discovery
      // file. If the announcing serve dies, claimEndpoint sees the on-disk owner go
      // un-alive and re-claims the file for THIS live door on the next tick — so the
      // door never ends up serving while unannounced. unref()'d so it never keeps the
      // process alive; cleared on shutdown alongside the door close.
      const reconDir = join(projectRoot, '.recon-wrxn');
      const heartbeat = setInterval(
        () => claimEndpoint(reconDir, { pid: process.pid, port: door.port }),
        10000,
      );
      heartbeat.unref();
      // Best-effort discovery-file cleanup on clean shutdown — SIGINT/SIGTERM/stdin-end
      // all funnel through startServer → process.exit(0) → 'exit'. A SIGKILL leaves a
      // stale file, but the reader's pid liveness probe treats it as "not warm".
      process.on('exit', () => {
        clearInterval(heartbeat);
        door.close();
      });
      console.error(`[recon] HTTP query door on 127.0.0.1:${door.port} (concurrent with stdio).`);
    }

    console.error('[recon] MCP server starting on stdio...');
    // Pass a GETTER so each CallTool resolves the current store — this is what
    // makes the mid-session hybrid swap visible without a restart. indexedCommit is
    // the freshness watermark base ([#9]); each CallTool computes the live dirty count.
    await startServer(graph, projectRoot, () => liveStore, indexedCommit);
  }
}

// ??? status command ??????????????????????????????????????????????

export async function statusCommand(options?: { repo?: string }): Promise<void> {
  const projectRoot = findProjectRoot();
  const repoName = options?.repo;
  const stored = await loadIndex(projectRoot, repoName);

  if (!stored) {
    console.log('[recon] No index found. Run "npx recon-wrxn index" first.');
    return;
  }

  const { meta, graph } = stored;
  const git = getGitInfo(projectRoot);
  const stale = meta.gitCommit !== git.commit;

  console.log('recon-wrxn Index Status');
  console.log('='.repeat(34));
  console.log(`  Indexed at:     ${meta.indexedAt}`);
  console.log(`  Git commit:     ${meta.gitCommit}${stale ? ` (HEAD is ${git.commit} ??STALE)` : ' (current)'}`);
  console.log(`  Git branch:     ${meta.gitBranch}`);
  console.log(`  Tree-sitter:    ${meta.stats.treeSitterFiles || 0} files, ${meta.stats.treeSitterSymbols || 0} symbols`);
  console.log(`  Relationships:  ${meta.stats.relationships}`);
  console.log(`  Total nodes:    ${graph.nodeCount}`);
  console.log(`  Index time:     ${meta.stats.indexTimeMs}ms`);

  if (detectV6Index(projectRoot)) {
    const sqliteStore = new SqliteStore(projectRoot);
    console.log(`  SQLite:         ${sqliteStore.nodeCount} nodes, ${sqliteStore.relationshipCount} relationships`);
    sqliteStore.close();
  }

  if (stale) {
    console.log('');
    console.log('  ??Index is stale. Run "npx recon-wrxn index" to update.');
  }
}

// ??? clean command ???????????????????????????????????????????????

export function cleanCommand(options?: { repo?: string }): void {
  const projectRoot = findProjectRoot();
  const repoName = options?.repo;

  if (repoName) {
    const repoDir = join(projectRoot, '.recon-wrxn', 'repos', repoName);
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
      console.log(`[recon] Index for repo '${repoName}' cleaned.`);
    } else {
      console.log(`[recon] No index found for repo '${repoName}'.`);
    }
  } else {
    const reconDir = join(projectRoot, '.recon-wrxn');
    if (existsSync(reconDir)) {
      rmSync(reconDir, { recursive: true, force: true });
      console.log('[recon] Index cleaned.');
    } else {
      console.log('[recon] No index to clean.');
    }
  }
}

// ═══ export command ═══════════════════════════════════════════════

export async function exportCommand(options: {
  format?: string;
  package?: string;
  type?: string;
  symbol?: string;
  depth?: number;
  edges?: string;
  limit?: number;
  direction?: string;
  repo?: string;
}): Promise<void> {
  const { exportGraph } = await import('../export/exporter.js');

  const projectRoot = findProjectRoot();
  const repoName = options.repo;

  // Load graph
  const stored = await loadIndex(projectRoot, repoName);
  if (!stored) {
    console.error("[recon] No index found. Run 'npx recon-wrxn index' first.");
    process.exit(1);
  }

  const format = 'mermaid' as const;

  // Parse type filter
  const types = options.type
    ? options.type.split(',').map(t => t.trim() as NodeType).filter(t => Object.values(NodeType).includes(t))
    : undefined;

  // Parse edge filter
  const edges = options.edges
    ? options.edges.split(',').map(e => e.trim() as RelationshipType).filter(e => Object.values(RelationshipType).includes(e))
    : undefined;

  const output = exportGraph(stored.graph, {
    format,
    package: options.package,
    types,
    symbol: options.symbol,
    depth: options.depth,
    edges,
    limit: options.limit ?? 50,
    direction: (options.direction as 'TD' | 'LR') ?? undefined,
    skipFiles: true,
  });

  // Output to stdout for piping
  process.stdout.write(output + '\n');
}



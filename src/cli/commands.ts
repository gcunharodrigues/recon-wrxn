/**
 * CLI Commands
 *
 * Implementation of index, serve, status, clean commands.
 */

import { execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { KnowledgeGraph } from '../graph/graph.js';
import { buildCrossLanguageEdges, extractGoRoutes } from '../analyzers/cross-language.js';
import type { APIRoute } from '../analyzers/cross-language.js';
import { saveIndex, saveSearchIndex, saveEmbeddings, saveSearchText, loadIndex, loadEmbeddings, loadSearchText, loadAllRepos } from '../storage/store.js';
import { SqliteStore } from '../storage/sqlite.js';
import { detectV5Index, migrateV5ToV6, detectV6Index } from '../storage/migrate.js';
import { generateAgentsMd } from '../generators/agents-gen.js';
import type { IndexMeta } from '../storage/types.js';
import { startServer } from '../mcp/server.js';
import { setFulltextRanker } from '../mcp/find.js';
import { BM25Index } from '../search/bm25.js';
import { VectorStore } from '../search/vector-store.js';
import { generateEmbeddingText, isEmbeddable } from '../search/text-generator.js';
import { initEmbedder, embedBatch, disposeEmbedder, DEFAULT_CONFIG } from '../search/embedder.js';
import { analyzeTreeSitter, analyzeTreeSitterParallel } from '../analyzers/tree-sitter/index.js';
import { analyzeMarkdown, findMarkdownFiles } from '../analyzers/markdown.js';
import type { MarkdownAnalysisResult } from '../analyzers/markdown.js';
import { getAvailableLanguages } from '../analyzers/tree-sitter/index.js';
import { carryOverUnchangedTreeSitter } from '../analyzers/tree-sitter/carryover.js';
import { detectCommunities } from '../graph/community.js';
import { NodeType, RelationshipType } from '../graph/types.js';
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
  repoName?: string,
): Promise<MarkdownAnalysisResult> {
  const mdResult = analyzeMarkdown(findMarkdownFiles(walkRoot, ignore));
  for (const node of mdResult.nodes) {
    graph.addNode(node);
  }
  for (const rel of mdResult.relationships) {
    graph.addRelationship(rel);
  }
  await saveSearchText(saveRoot, mdResult.searchText, repoName);
  return mdResult;
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
    const tsitterResult = analyzeTreeSitter(resolvedDir, undefined, extConfig.ignore);
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
  const mdResult = await ingestProse(graph, resolvedDir, mainProjectRoot, extConfig.ignore, name);
  if (mdResult.warnings.length > 0) {
    console.error(`[recon] ${mdResult.warnings.length} markdown file(s) skipped due to errors:`);
    for (const w of mdResult.warnings) {
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

export async function indexCommand(options: { force?: boolean; repo?: string; embeddings?: boolean }): Promise<void> {
  const startTime = performance.now();
  const projectRoot = findProjectRoot();
  const repoName = options.repo;

  console.log(`[recon] Indexing from ${projectRoot}${repoName ? ` (repo: ${repoName})` : ''}...`);

  // Load .recon-wrxn.json so ignore patterns (e.g. worktree subtrees) prune the walk
  const config = loadConfig(projectRoot);

  // Load previous index for incremental comparison
  const previousIndex = options.force ? null : await loadIndex(projectRoot, repoName);
  const previousHashes = previousIndex?.meta.fileHashes;

  if (previousIndex && !options.force) {
    console.log('[recon] Previous index found ??using incremental mode.');
  }

  // Build graph
  const graph = new KnowledgeGraph();

  // Tree-sitter analysis (TS/TSX now flow through here like every other grammar)
  const tsitterLangs = getAvailableLanguages();
  let tsitterSymbols = 0;
  let tsitterFiles = 0;
  let tsitterHashes: Record<string, string> = {};
  if (tsitterLangs.length > 0) {
    console.log(`[recon] Analyzing with tree-sitter (${tsitterLangs.join(', ')})...`);
    const tsitterResult = await analyzeTreeSitterParallel(projectRoot, previousHashes, config.ignore);

    for (const node of tsitterResult.result.nodes) {
      graph.addNode(node);
    }
    for (const rel of tsitterResult.result.relationships) {
      graph.addRelationship(rel);
    }

    tsitterSymbols = tsitterResult.stats.symbols;
    tsitterFiles = tsitterResult.stats.files;
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
  const mdResult = await ingestProse(graph, projectRoot, projectRoot, config.ignore, repoName);
  console.log(`[recon] Prose: ${mdResult.nodes.length} nodes, ${mdResult.relationships.length} edges`);
  if (mdResult.warnings.length > 0) {
    console.log(`[recon] ${mdResult.warnings.length} markdown file(s) skipped due to errors:`);
    for (const w of mdResult.warnings) {
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
    fileHashes: { ...tsitterHashes },
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
      await initEmbedder();

      // Collect embeddable nodes
      const embeddableNodes: Array<{ id: string; text: string }> = [];
      for (const node of graph.nodes.values()) {
        if (isEmbeddable(node)) {
          embeddableNodes.push({
            id: node.id,
            text: generateEmbeddingText(node),
          });
        }
      }

      if (embeddableNodes.length > 0) {
        const texts = embeddableNodes.map(n => n.text);
        const embeddings = await embedBatch(texts);
        const vectorStore = new VectorStore(DEFAULT_CONFIG.dimensions);

        for (let i = 0; i < embeddableNodes.length; i++) {
          vectorStore.add(embeddableNodes[i].id, embeddings[i]);
        }

        await saveEmbeddings(projectRoot, vectorStore, repoName);
        console.log(`[recon] Embeddings: ${vectorStore.size} vectors (${DEFAULT_CONFIG.dimensions}d)`);
      }

      await disposeEmbedder();
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

export async function serveCommand(options?: { repo?: string; http?: boolean; port?: number; noIndex?: boolean; noWatch?: boolean; projects?: string[] }): Promise<void> {
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
    const needsIndex = !existing || existing.meta.gitCommit !== git.commit;

    if (needsIndex) {
      const reason = !existing ? 'no index found' : 'index is stale';
      console.error(`[recon] Auto-indexing (${reason})...`);
      // embeddings:false — the serve auto-index must NOT regenerate embeddings.
      // Embedding generation auto-enables (when @huggingface/transformers is present)
      // and re-embeds the WHOLE graph synchronously, blocking serve startup by ~2min on
      // a large graph. No MCP tool consumes embeddings today: recon_find → handleFind →
      // executeFind is a pure graph name/pattern search, and hybrid-search.ts (BM25+vector)
      // has no live caller in the stdio or HTTP handler path (both route through
      // handleToolCall, which never forwards vectorStore to handleFind). So the embed pass
      // was pure wasted startup cost. Embeddings remain available via an explicit
      // `recon index` (with embeddings) for whenever hybrid search is actually wired to the
      // tools — at which point a detached/non-blocking embed + stale-vector guard becomes a
      // real story (tracked as BL-038 follow-on; blocked on the embedder module-singleton
      // lifecycle, embedder.ts `_pipeline`).
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

  if (repoName) {
    // Load specific repo
    const stored = await loadIndex(projectRoot, repoName);
    if (!stored) {
      console.error(`[recon] No index found for repo '${repoName}'. Run 'npx recon-wrxn index --repo ${repoName}' first.`);
      process.exit(1);
    }
    graph = stored.graph;
    vectorStore = await loadEmbeddings(projectRoot, repoName);
    console.error(`[recon] Loaded repo '${repoName}': ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships`);
  } else {
    // Try loading all repos (merged), fall back to legacy single index
    const allRepos = await loadAllRepos(projectRoot);
    if (allRepos) {
      graph = allRepos.graph;
      const repoNames = allRepos.repos.map(r => r.name).join(', ');
      console.error(`[recon] Loaded ${allRepos.repos.length} repo(s) [${repoNames}]: ${graph.nodeCount} nodes, ${graph.relationshipCount} relationships`);
    } else {
      const stored = await loadIndex(projectRoot);
      if (!stored) {
        console.error("[recon] No index found. Run 'npx recon-wrxn index' first.");
        process.exit(1);
      }
      graph = stored.graph;
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
    const watcher = new ReconWatcher(graph, watchDirs, config.watchDebounce, config.ignore, projectRoot);
    watcher.start();
  }

  if (config.http || options?.http) {
    const { startHttpServer } = await import('../server/http.js');
    const port = options?.port || config.port;
    await startHttpServer({ port, graph, projectRoot, vectorStore });
    // Keep process alive
    await new Promise(() => { });
  } else {
    console.error('[recon] MCP server starting on stdio...');
    await startServer(graph, projectRoot, vectorStore);
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



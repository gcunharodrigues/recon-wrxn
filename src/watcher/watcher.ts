/**
 * File Watcher — Surgical Live Re-Index
 *
 * Watches source files with chokidar. On change:
 * 1. Remove old nodes for the file (graph.removeNodesByFile)
 * 2. Re-parse the single file with tree-sitter
 * 3. Insert new nodes + edges in-place
 *
 * The graph is mutated directly so MCP handlers see updates immediately.
 */

import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { KnowledgeGraph } from '../graph/graph.js';
import { NodeType, RelationshipType } from '../graph/types.js';
import { extractFromFile } from '../analyzers/tree-sitter/extractor.js';
import { getLanguageForFile, isLanguageAvailable } from '../analyzers/tree-sitter/parser.js';
import { analyzeMarkdown } from '../analyzers/markdown.js';
import { analyzeSource, BINARY_SOURCE_EXTENSIONS, SOURCE_EXTENSIONS } from '../analyzers/source.js';
import type { SourceFile } from '../analyzers/source.js';
import { saveIndex, loadSearchText, saveSearchText } from '../storage/store.js';
import { SqliteStore } from '../storage/sqlite.js';
import type { IndexMeta } from '../storage/types.js';

/**
 * Find narrowest enclosing function/method for tree-sitter extracted symbols.
 * (Inlined from the removed watcher-ts.ts — the only helper the surviving
 * tree-sitter surgical-update path still needs after the compiler-API TS path
 * was dropped.)
 */
function findEnclosingExtracted(
  symbols: Array<{ id: string; name: string; type: NodeType; startLine: number; endLine: number }>,
  line: number,
): { id: string; name: string } | null {
  let best: typeof symbols[0] | null = null;
  for (const sym of symbols) {
    if (sym.type !== NodeType.Function && sym.type !== NodeType.Method) continue;
    if (sym.startLine <= line && sym.endLine >= line) {
      if (!best || (sym.endLine - sym.startLine) < (best.endLine - best.startLine)) {
        best = sym;
      }
    }
  }
  return best;
}

// ─── Types ───────────────────────────────────────────────────────

export interface ProjectDir {
  dir: string;       // Absolute path to project directory
  repoName: string;  // Name stamped on nodes
}

export interface WatcherStatus {
  active: boolean;
  startedAt: string | null;
  watchDirs: string[];
  totalUpdates: number;
  lastUpdate: {
    file: string;
    timestamp: string;
    durationMs: number;
  } | null;
  pendingCount: number;
  errors: Array<{
    file: string;
    error: string;
    timestamp: string;
  }>;
}

/** Shared singleton — imported by MCP handler */
export const watcherStatus: WatcherStatus = {
  active: false,
  startedAt: null,
  watchDirs: [],
  totalUpdates: 0,
  lastUpdate: null,
  pendingCount: 0,
  errors: [],
};

// ─── Supported Extensions ────────────────────────────────────────

const TREE_SITTER_EXTENSIONS = new Set([
  '.go', '.py', '.rs', '.java', '.c', '.cpp', '.rb', '.php', '.kt', '.swift', '.cs',
  '.ts', '.tsx', '.mts', '.cts',
]);
// Prose has no tree-sitter grammar; it is handled by the standalone markdown
// analyzer (slice 01) on a separate dispatch branch below.
const MARKDOWN_EXTENSIONS = new Set(['.md']);
// Multi-format source (multiformat-distill-01): html/txt + minimal binary nodes.
const ALL_EXTENSIONS = new Set([...TREE_SITTER_EXTENSIONS, ...MARKDOWN_EXTENSIONS, ...SOURCE_EXTENSIONS]);

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot) : '';
}

function isWatchableFile(path: string): boolean {
  const ext = getExtension(path);
  if (!ALL_EXTENSIONS.has(ext)) return false;
  if (path.includes('.test.') || path.includes('.spec.') || path.endsWith('.d.ts')) return false;
  return true;
}

// ─── Watcher Class ───────────────────────────────────────────────

export class ReconWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private indexLock = false;
  private pendingQueue: Array<{ absPath: string; repoName: string }> = [];
  private unsavedUpdates = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly SAVE_EVERY_N = 5;
  private readonly SAVE_INTERVAL_MS = 30_000;
  private isSaving = false;

  constructor(
    private graph: KnowledgeGraph,
    private projectDirs: ProjectDir[],
    private debounceMs = 1500,
    private customIgnore: string[] = [],
    private projectRoot?: string,
    private maxFileSize: number = Infinity,
    private store?: SqliteStore,
  ) {}

  /**
   * Start watching all project directories for file changes.
   */
  start(): void {
    const watchPaths = this.projectDirs.map(p => p.dir);

    const extraIgnore = this.customIgnore.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    this.watcher = chokidar.watch(watchPaths, {
      ignored: [
        /node_modules/,
        /\.git/,
        /\.recon-wrxn/,
        /dist\//,
        /\.next/,
        /build\//,
        /coverage\//,
        ...extraIgnore,
      ],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      atomic: true,
    });

    this.watcher
      .on('change', (filePath) => this.handleFileEvent(filePath, 'change'))
      .on('add', (filePath) => this.handleFileEvent(filePath, 'add'))
      .on('unlink', (filePath) => this.handleFileEvent(filePath, 'unlink'))
      .on('error', (error) => console.error(`[recon:watch] Error: ${error}`));

    const dirNames = this.projectDirs.map(p => p.repoName).join(', ');
    console.error(`[recon:watch] Watching: ${dirNames}`);

    watcherStatus.active = true;
    watcherStatus.startedAt = new Date().toISOString();
    watcherStatus.watchDirs = this.projectDirs.map(p => p.repoName);

    const shutdown = async () => {
      await this.persistGraph();
      this.stop();
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    watcherStatus.active = false;
  }

  // ─── Auto-Save ──────────────────────────────────────────────────

  private maybeAutoSave(): void {
    this.unsavedUpdates++;

    if (this.unsavedUpdates >= this.SAVE_EVERY_N) {
      void this.persistGraph();
      return;
    }

    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => void this.persistGraph(), this.SAVE_INTERVAL_MS);
    }
  }

  private async persistGraph(): Promise<void> {
    if (!this.projectRoot || this.unsavedUpdates === 0 || this.isSaving) return;

    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }

    const count = this.unsavedUpdates;
    this.unsavedUpdates = 0;
    this.isSaving = true;

    try {
      const meta: IndexMeta = {
        version: 1,
        indexedAt: new Date().toISOString(),
        gitCommit: 'watcher',
        gitBranch: 'live',
        stats: { tsModules: 0, tsSymbols: 0, relationships: 0, indexTimeMs: 0 },
        fileHashes: {},
      };
      await saveIndex(this.projectRoot, this.graph, meta);
      console.error(`[recon:watch] Auto-saved graph (${count} updates)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[recon:watch] Auto-save failed: ${msg}`);
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Handle a file system event with debouncing.
   */
  private handleFileEvent(filePath: string, event: string): void {
    const absPath = resolve(filePath);
    if (!isWatchableFile(absPath)) return;

    const project = this.projectDirs.find(p => absPath.startsWith(resolve(p.dir)));
    if (!project) return;

    const existing = this.debounceTimers.get(absPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      this.enqueue(absPath, project.repoName, event);
    }, this.debounceMs);

    this.debounceTimers.set(absPath, timer);
  }

  /**
   * Enqueue a file for processing, respecting the lock.
   */
  private enqueue(absPath: string, repoName: string, event: string): void {
    if (this.indexLock) {
      this.pendingQueue.push({ absPath, repoName });
      return;
    }
    this.processFile(absPath, repoName, event);
  }

  /**
   * Process a single file change — the core surgical update.
   */
  private async processFile(absPath: string, repoName: string, event: string): Promise<void> {
    this.indexLock = true;

    try {
      const project = this.projectDirs.find(p => absPath.startsWith(resolve(p.dir)));
      if (!project) return;

      const relPath = relative(project.dir, absPath).replace(/\\/g, '/');
      const ext = getExtension(absPath);
      const startTime = performance.now();

      if (event === 'unlink') {
        if (MARKDOWN_EXTENSIONS.has(ext)) {
          // Prune the prose nodes AND the file's search-text.json entries.
          await this.surgicalUpdateMarkdown(absPath, relPath, 'unlink');
        } else if (SOURCE_EXTENSIONS.has(ext)) {
          // Prune the Source node + any search-text.json entry (text-native).
          await this.surgicalUpdateSource(absPath, relPath, 'unlink');
        } else {
          const removed = this.graph.removeNodesByFile(relPath);
          if (removed > 0) {
            console.error(`[recon:watch] Removed ${removed} nodes (file deleted: ${relPath})`);
          }
          if (this.store) {
            this.store.removeNodesByFile(relPath);
          }
        }
        return;
      }

      if (TREE_SITTER_EXTENSIONS.has(ext)) {
        this.surgicalUpdateTreeSitter(absPath, relPath, repoName);
      } else if (MARKDOWN_EXTENSIONS.has(ext)) {
        await this.surgicalUpdateMarkdown(absPath, relPath, event);
      } else if (SOURCE_EXTENSIONS.has(ext)) {
        await this.surgicalUpdateSource(absPath, relPath, event);
      }

      // Persist file changes to SQLite if store is available
      if (this.store) {
        this.store.removeNodesByFile(relPath);
        const fileNodes = [...this.graph.nodes.values()].filter(n => n.file === relPath);
        if (fileNodes.length > 0) this.store.insertNodes(fileNodes);

        const nodeIds = new Set(fileNodes.map(n => n.id));
        const rels = [...this.graph.allRelationships()].filter(
          r => nodeIds.has(r.sourceId) || nodeIds.has(r.targetId),
        );
        if (rels.length > 0) this.store.insertRelationships(rels);
      }

      const elapsed = Math.round(performance.now() - startTime);
      console.error(`[recon:watch] Updated ${relPath} (${elapsed}ms)`);

      watcherStatus.totalUpdates++;
      watcherStatus.lastUpdate = {
        file: relPath,
        timestamp: new Date().toISOString(),
        durationMs: elapsed,
      };

      this.maybeAutoSave();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[recon:watch] Error processing ${absPath}: ${msg}`);

      watcherStatus.errors.push({
        file: absPath,
        error: msg,
        timestamp: new Date().toISOString(),
      });
      if (watcherStatus.errors.length > 10) watcherStatus.errors.shift();
    } finally {
      this.indexLock = false;
      watcherStatus.pendingCount = this.pendingQueue.length;

      if (this.pendingQueue.length > 0) {
        const next = this.pendingQueue.shift()!;
        this.processFile(next.absPath, next.repoName, 'change');
      }
    }
  }

  // ─── Collect Incoming Callers ──────────────────────────────────

  private collectIncomingCallers(relPath: string): {
    oldNodeIds: Set<string>;
    incomingCallers: Array<{ sourceId: string; targetName: string; type: RelationshipType }>;
  } {
    const oldNodeIds = new Set<string>();
    const oldSymbolNames = new Map<string, string>();
    for (const [id, node] of this.graph.nodes) {
      if (node.file === relPath) {
        oldNodeIds.add(id);
        if (node.type !== NodeType.File) {
          oldSymbolNames.set(id, node.name);
        }
      }
    }

    const incomingCallers: Array<{ sourceId: string; targetName: string; type: RelationshipType }> = [];
    for (const nodeId of oldNodeIds) {
      const incoming = this.graph.getIncoming(nodeId);
      for (const rel of incoming) {
        if (!oldNodeIds.has(rel.sourceId)) {
          const targetName = oldSymbolNames.get(nodeId);
          if (targetName) {
            incomingCallers.push({ sourceId: rel.sourceId, targetName, type: rel.type });
          }
        }
      }
    }

    return { oldNodeIds, incomingCallers };
  }

  /**
   * Re-link incoming callers from other files to new symbol IDs.
   */
  private relinkCallers(
    incomingCallers: Array<{ sourceId: string; targetName: string; type: RelationshipType }>,
    newSymbolMap: Map<string, string>,
    relCounter: { value: number },
  ): void {
    for (const caller of incomingCallers) {
      const newTargetId = newSymbolMap.get(caller.targetName);
      if (newTargetId && this.graph.getNode(caller.sourceId)) {
        this.graph.addRelationship({
          id: `rel:watch:${++relCounter.value}`,
          type: caller.type,
          sourceId: caller.sourceId,
          targetId: newTargetId,
          confidence: 0.7,
        });
      }
    }
  }

  // ─── Tree-sitter Surgical Update ───────────────────────────────

  private surgicalUpdateTreeSitter(
    absPath: string,
    relPath: string,
    repoName: string,
  ): void {
    const language = getLanguageForFile(absPath);
    if (!language || !isLanguageAvailable(language)) return;

    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      this.graph.removeNodesByFile(relPath);
      return;
    }

    // 1. Save incoming callers BEFORE removal
    const { incomingCallers } = this.collectIncomingCallers(relPath);

    // 2. Remove old nodes
    this.graph.removeNodesByFile(relPath);

    // 3. Extract symbols, calls, imports, heritage
    const extraction = extractFromFile(relPath, content, language);
    if (extraction.symbols.length === 0) return;

    // 4. Add File node
    const fileNodeId = `${language}:file:${relPath}`;
    this.graph.addNode({
      id: fileNodeId,
      type: NodeType.File,
      name: relPath.split('/').pop() || relPath,
      file: relPath,
      startLine: 0,
      endLine: 0,
      language,
      package: extraction.symbols[0]?.package || '',
      exported: true,
      repo: repoName,
    });

    // 5. Add symbol nodes + DEFINES edges
    const relCounter = { value: Date.now() };
    const newSymbolMap = new Map<string, string>();

    for (const sym of extraction.symbols) {
      this.graph.addNode({
        id: sym.id,
        type: sym.type,
        name: sym.name,
        file: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        language: sym.language,
        package: sym.package,
        exported: sym.exported,
        repo: repoName,
      });

      this.graph.addRelationship({
        id: `rel:watch:${++relCounter.value}`,
        type: RelationshipType.DEFINES,
        sourceId: fileNodeId,
        targetId: sym.id,
        confidence: 1.0,
      });

      newSymbolMap.set(sym.name, sym.id);
    }

    // 6. Resolve CALLS edges
    for (const call of extraction.calls) {
      const caller = findEnclosingExtracted(extraction.symbols, call.line);
      if (!caller) continue;

      const targets = this.graph.findByName(call.calleeName);
      const target = targets.find(n =>
        n.file !== relPath && n.exported &&
        (n.type === NodeType.Function || n.type === NodeType.Method),
      );

      if (target && target.id !== caller.id) {
        this.graph.addRelationship({
          id: `rel:watch:${++relCounter.value}`,
          type: RelationshipType.CALLS,
          sourceId: caller.id,
          targetId: target.id,
          confidence: 0.7,
        });
      }
    }

    // 7. HAS_METHOD edges
    const methods = extraction.symbols.filter(s => s.type === NodeType.Method);
    const classes = extraction.symbols.filter(s =>
      s.type === NodeType.Class || s.type === NodeType.Struct || s.type === NodeType.Trait,
    );
    for (const method of methods) {
      const enclosing = classes.find(
        c => c.startLine <= method.startLine && c.endLine >= method.endLine,
      );
      if (enclosing) {
        this.graph.addRelationship({
          id: `rel:watch:${++relCounter.value}`,
          type: RelationshipType.HAS_METHOD,
          sourceId: enclosing.id,
          targetId: method.id,
          confidence: 1.0,
        });
      }
    }

    // 8. EXTENDS / IMPLEMENTS edges
    for (const h of extraction.heritage) {
      const childId = newSymbolMap.get(h.childName);
      if (!childId) continue;

      const parents = this.graph.findByName(h.parentName);
      const parent = parents.find(n => n.file !== relPath) || parents[0];
      if (!parent) continue;

      const relType = h.kind === 'extends' ? RelationshipType.EXTENDS : RelationshipType.IMPLEMENTS;
      this.graph.addRelationship({
        id: `rel:watch:${++relCounter.value}`,
        type: relType,
        sourceId: childId,
        targetId: parent.id,
        confidence: 0.9,
      });
    }

    // 9. Re-link incoming callers
    this.relinkCallers(incomingCallers, newSymbolMap, relCounter);
  }

  // ─── Markdown Surgical Update ──────────────────────────────────

  /**
   * Surgical live update for a `.md` file — the non-tree-sitter path.
   *
   * Prose has no tree-sitter grammar, so it is reparsed with the standalone
   * markdown analyzer (slice 01). On add/change: drop the file's old prose
   * nodes, reparse THAT ONE file, re-add its Page/Section nodes + CONTAINS
   * edges, and update its entries in the search-text.json snapshot. On unlink:
   * drop the nodes and prune the snapshot. Other files' nodes and snapshot
   * entries are never touched — the cost is O(one file) (~38ms, SPIKE §6).
   */
  private async surgicalUpdateMarkdown(
    absPath: string,
    relPath: string,
    event: string,
  ): Promise<void> {
    // A prose file's node ids ARE its search-text.json keys (every Page/Section
    // node has a searchText entry). Collect them BEFORE removal so the snapshot
    // is pruned in lock-step with the graph.
    const staleKeys: string[] = [];
    for (const node of this.graph.nodes.values()) {
      if (node.file === relPath) staleKeys.push(node.id);
    }

    this.graph.removeNodesByFile(relPath);

    let freshSearchText: Record<string, string> = {};
    if (event !== 'unlink') {
      // NOTE: no MAX_FILE_SIZE cap here — pre-existing markdown behavior, out of
      // scope for multiformat-distill-01 (the source path below IS capped).
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        // File vanished between the event and the read — treat as a pure
        // removal: the nodes are already gone, just prune the snapshot.
        await this.updateSearchTextSnapshot(staleKeys, {});
        return;
      }

      const result = analyzeMarkdown([{ path: relPath, content }]);
      for (const node of result.nodes) this.graph.addNode(node);
      for (const rel of result.relationships) this.graph.addRelationship(rel);
      freshSearchText = result.searchText;
    }

    await this.updateSearchTextSnapshot(staleKeys, freshSearchText);
  }

  // ─── Source Surgical Update ────────────────────────────────────

  /**
   * Surgical live update for a multi-format Source file (html/txt + binary
   * pdf/docx/pptx/xlsx) — multiformat-distill-01. Mirrors surgicalUpdateMarkdown:
   * drop the file's old Source node, reparse THAT ONE file, re-add it, and keep
   * its search-text.json entry in lock-step. Text-native files carry a body →
   * searchText; binary files are read-free minimal nodes (no snapshot entry). On
   * unlink: drop the node + prune the snapshot. Other files are never touched.
   */
  private async surgicalUpdateSource(
    absPath: string,
    relPath: string,
    event: string,
  ): Promise<void> {
    // A text-native Source node's id IS its search-text.json key. Collect every
    // node id for this file BEFORE removal so the snapshot is pruned in lock-step
    // (binary ids simply aren't in the snapshot → the delete is a harmless no-op).
    const staleKeys: string[] = [];
    for (const node of this.graph.nodes.values()) {
      if (node.file === relPath) staleKeys.push(node.id);
    }

    this.graph.removeNodesByFile(relPath);

    let freshSearchText: Record<string, string> = {};
    if (event !== 'unlink') {
      const ext = getExtension(absPath).toLowerCase();
      let file: SourceFile;
      if (BINARY_SOURCE_EXTENSIONS.has(ext)) {
        file = { path: relPath, kind: 'binary', ext };
      } else {
        // Optional OOM escape hatch (multiformat-distill-04): when the install
        // configures a finite maxFileSize, cap the read at it BEFORE reading so a
        // watcher event on an oversized text-native source can't OOM the long-lived
        // process. DEFAULTS to unlimited (no cap), matching the walkers. Over-cap
        // (or a vanished file) → treat as removal: nodes already gone, just prune.
        if (Number.isFinite(this.maxFileSize)) {
          try {
            if (statSync(absPath).size > this.maxFileSize) {
              await this.updateSearchTextSnapshot(staleKeys, {});
              return;
            }
          } catch {
            await this.updateSearchTextSnapshot(staleKeys, {});
            return;
          }
        }
        let content: string;
        try {
          content = readFileSync(absPath, 'utf-8');
        } catch {
          // File vanished between the event and the read — treat as a pure
          // removal: nodes already gone, just prune the snapshot.
          await this.updateSearchTextSnapshot(staleKeys, {});
          return;
        }
        file = { path: relPath, kind: 'text', ext, content };
      }

      const result = analyzeSource([file]);
      for (const node of result.nodes) this.graph.addNode(node);
      freshSearchText = result.searchText;
    }

    await this.updateSearchTextSnapshot(staleKeys, freshSearchText);
  }

  /**
   * Read-modify-write the search-text.json snapshot: drop the changed file's
   * old keys, then merge its fresh ones. Scoped to one file, so every other
   * file's lexical input is preserved. No-op when projectRoot is unknown
   * (mirrors persistGraph) or when there is nothing to change. Uses the legacy
   * root location — the same place persistGraph writes graph.json and `serve`
   * loads the snapshot from in the single-repo case.
   */
  private async updateSearchTextSnapshot(
    staleKeys: string[],
    fresh: Record<string, string>,
  ): Promise<void> {
    if (!this.projectRoot) return;
    if (staleKeys.length === 0 && Object.keys(fresh).length === 0) return;

    const snapshot = (await loadSearchText(this.projectRoot)) ?? {};
    for (const key of staleKeys) delete snapshot[key];
    Object.assign(snapshot, fresh);
    await saveSearchText(this.projectRoot, snapshot);
  }
}

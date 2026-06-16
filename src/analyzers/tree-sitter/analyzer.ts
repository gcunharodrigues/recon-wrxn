/**
 * Tree-sitter Analyzer
 *
 * Walks a directory for Python, Rust, Java, C, and C++ source files,
 * parses them with tree-sitter, and returns an AnalyzerResult.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Language } from '../../graph/types.js';
import type { AnalyzerResult, AnalyzerWarning } from '../types.js';
import { getLanguageForFile, isLanguageAvailable, getAvailableLanguages } from './parser.js';
import { extractFromFile, buildGraphFromExtractions } from './extractor.js';
import type { FileExtractionResult } from './extractor.js';
import { hashContent } from '../../utils/hash.js';
import { IGNORE_DIRS } from '../ignore.js';

// ─── Ignore patterns ────────────────────────────────────────────
// IGNORE_DIRS is the shared single source of truth (../ignore) — all walkers
// (markdown, source, code) prune the same dirs, no drift.

const MAX_FILE_SIZE = 1_000_000; // 1 MB

// ─── File Discovery ─────────────────────────────────────────────

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  language: Language;
}

export function findSourceFiles(rootDir: string, ignore: string[] = []): SourceFile[] {
  const files: SourceFile[] = [];

  // Path-prefix ignore patterns from config (e.g. ["projects", "docs/legacy"]).
  // Normalized to bare relative prefixes; matched against each dir's rootDir-relative
  // path so a whole subtree is pruned at the walk (cheaper than per-file filtering).
  const ignorePrefixes = ignore
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);

  function isIgnoredPath(relPath: string): boolean {
    return ignorePrefixes.some((p) => relPath === p || relPath.startsWith(p + '/'));
  }

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Denylist only — the blanket `entry.name.startsWith('.')` skip was removed so that
        // meaningful dot-dirs (e.g. `.claude/`, `.aiox-core/`) ARE indexed. Noise dot-dirs are
        // named explicitly in IGNORE_DIRS; non-source files are still excluded by the language
        // filter (getLanguageForFile) + MAX_FILE_SIZE below.
        if (IGNORE_DIRS.has(entry.name)) continue;
        const childAbs = join(dir, entry.name);
        const childRel = relative(rootDir, childAbs).replace(/\\/g, '/');
        if (isIgnoredPath(childRel)) continue;
        walk(childAbs);
      } else if (entry.isFile()) {
        const absPath = join(dir, entry.name);
        const lang = getLanguageForFile(entry.name);
        if (!lang) continue;
        if (!isLanguageAvailable(lang)) continue;

        try {
          const stat = statSync(absPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        files.push({
          absolutePath: absPath,
          relativePath: relative(rootDir, absPath).replace(/\\/g, '/'),
          language: lang,
        });
      }
    }
  }

  walk(rootDir);
  return files;
}

// ─── Main Analyzer ──────────────────────────────────────────────

export interface TreeSitterAnalysisResult {
  result: AnalyzerResult;
  stats: {
    files: number;
    symbols: number;
    calls: number;
    skipped: number;
    languages: Record<string, number>;
  };
  fileHashes: Record<string, string>;
  /**
   * Project-relative paths of files that were freshly (re)analyzed this run AND
   * extracted successfully. Consumed by the incremental carry-over in
   * indexCommand to know which previous-index nodes are stale (their file was
   * re-parsed) vs. carryable (their file was skipped-unchanged). A parse-FAILED
   * file is absent here AND absent from fileHashes, so it is neither carried nor
   * marked seen — it is retried on the next run.
   */
  analyzedFiles: string[];
  warnings: AnalyzerWarning[];
}

/**
 * Analyze a codebase with tree-sitter for all supported languages.
 *
 * @param rootDir - Project root directory
 * @param previousHashes - Optional file hashes from previous index for incremental mode
 */
export function analyzeTreeSitter(
  rootDir: string,
  previousHashes?: Record<string, string>,
  ignore: string[] = [],
): TreeSitterAnalysisResult {
  const available = getAvailableLanguages();
  if (available.length === 0) {
    return {
      result: { nodes: [], relationships: [] },
      stats: { files: 0, symbols: 0, calls: 0, skipped: 0, languages: {} },
      fileHashes: {},
      analyzedFiles: [],
      warnings: [],
    };
  }

  const sourceFiles = findSourceFiles(rootDir, ignore);
  const fileHashes: Record<string, string> = {};
  const languageCounts: Record<string, number> = {};
  const warnings: AnalyzerWarning[] = [];
  let skipped = 0;

  // Read files and filter unchanged ones (incremental)
  interface FileToProcess {
    relativePath: string;
    content: string;
    language: Language;
    hash: string;
  }
  const filesToProcess: FileToProcess[] = [];

  for (const file of sourceFiles) {
    let content: string;
    try {
      content = readFileSync(file.absolutePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push({ file: file.relativePath, reason: message.split('\n')[0] });
      continue;
    }

    const hash = hashContent(content);

    if (previousHashes && previousHashes[file.relativePath] === hash) {
      // Unchanged & previously valid → record the hash so it stays "seen" and its
      // previous-index nodes can be carried over. (Hash for CHANGED files is recorded
      // only after a successful extraction below — never before — so a parse failure
      // leaves no stale hash and the file is retried next run.)
      fileHashes[file.relativePath] = hash;
      skipped++;
      continue;
    }

    filesToProcess.push({
      relativePath: file.relativePath,
      content,
      language: file.language,
      hash,
    });
  }

  // Extract symbols — sequential (always works)
  const extractions = new Map<string, FileExtractionResult>();
  let totalCalls = 0;

  for (const file of filesToProcess) {
    try {
      const result = extractFromFile(file.relativePath, file.content, file.language);
      extractions.set(file.relativePath, result);
      // Record the hash ONLY after extraction succeeds — a file that throws is left
      // out of fileHashes so it is re-attempted on the next index (no silent hole).
      fileHashes[file.relativePath] = file.hash;
      totalCalls += result.calls.length;

      const langKey = file.language;
      languageCounts[langKey] = (languageCounts[langKey] || 0) + 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push({ file: file.relativePath, reason: message.split('\n')[0] });
    }
  }

  // Build graph from extractions
  const graphResult = buildGraphFromExtractions(extractions);

  return {
    result: graphResult,
    stats: {
      files: extractions.size,
      symbols: graphResult.nodes.length,
      calls: totalCalls,
      skipped,
      languages: languageCounts,
    },
    fileHashes,
    analyzedFiles: [...extractions.keys()],
    warnings,
  };
}

/**
 * Async version that uses worker pool for large codebases.
 * Falls back to sequential analyzeTreeSitter if pool fails.
 *
 * @param rootDir - Project root directory
 * @param previousHashes - Optional file hashes for incremental mode
 */
export async function analyzeTreeSitterParallel(
  rootDir: string,
  previousHashes?: Record<string, string>,
  ignore: string[] = [],
): Promise<TreeSitterAnalysisResult> {
  const available = getAvailableLanguages();
  if (available.length === 0) {
    return {
      result: { nodes: [], relationships: [] },
      stats: { files: 0, symbols: 0, calls: 0, skipped: 0, languages: {} },
      fileHashes: {},
      analyzedFiles: [],
      warnings: [],
    };
  }

  const sourceFiles = findSourceFiles(rootDir, ignore);
  const fileHashes: Record<string, string> = {};
  const languageCounts: Record<string, number> = {};
  const warnings: AnalyzerWarning[] = [];
  let skipped = 0;

  // Read files and filter unchanged
  interface FileToProcess {
    relativePath: string;
    content: string;
    language: Language;
    hash: string;
  }
  const filesToProcess: FileToProcess[] = [];

  for (const file of sourceFiles) {
    let content: string;
    try {
      content = readFileSync(file.absolutePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push({ file: file.relativePath, reason: message.split('\n')[0] });
      continue;
    }

    const hash = hashContent(content);

    if (previousHashes && previousHashes[file.relativePath] === hash) {
      // Unchanged & previously valid → record hash now (stays "seen", nodes carryable).
      // Changed files get their hash recorded only after a successful parse below.
      fileHashes[file.relativePath] = hash;
      skipped++;
      continue;
    }

    filesToProcess.push({
      relativePath: file.relativePath,
      content,
      language: file.language,
      hash,
    });
  }

  // Below threshold → use sequential path
  const { WORKER_THRESHOLD, TreeSitterPool } = await import('./pool.js');
  if (filesToProcess.length < WORKER_THRESHOLD) {
    return analyzeTreeSitter(rootDir, previousHashes, ignore);
  }

  // Try parallel parsing with worker pool
  const pool = new TreeSitterPool();
  const poolStarted = pool.spawn();

  if (!poolStarted) {
    console.error('[recon] Worker pool unavailable, using sequential parser.');
    pool.terminate();
    return analyzeTreeSitter(rootDir, previousHashes, ignore);
  }

  console.error(`[recon] Worker pool started: ${pool.poolSize} threads for ${filesToProcess.length} files`);
  const parseStart = performance.now();

  try {
    const tasks = filesToProcess.map(f => ({
      filePath: f.relativePath,
      content: f.content,
      language: f.language,
    }));

    const parseResults = await pool.parseFiles(tasks);

    const hashByPath = new Map(filesToProcess.map(f => [f.relativePath, f.hash]));
    const extractions = new Map<string, FileExtractionResult>();
    let totalCalls = 0;

    for (const [filePath, pr] of parseResults) {
      if (pr.error) {
        // Parse failed under the worker pool → do NOT record its hash, so it is
        // retried next run instead of being silently marked seen-with-no-symbols.
        warnings.push({ file: filePath, reason: pr.error });
        continue;
      }
      extractions.set(filePath, pr.result);
      const h = hashByPath.get(filePath);
      if (h) fileHashes[filePath] = h;
      totalCalls += pr.result.calls.length;

      // Count languages
      const file = filesToProcess.find(f => f.relativePath === filePath);
      if (file) {
        languageCounts[file.language] = (languageCounts[file.language] || 0) + 1;
      }
    }

    const parseElapsed = Math.round(performance.now() - parseStart);
    console.error(`[recon] Worker pool: parsed ${extractions.size} files in ${parseElapsed}ms (${warnings.length} errors)`);

    // Build graph from extractions
    const graphResult = buildGraphFromExtractions(extractions);

    return {
      result: graphResult,
      stats: {
        files: extractions.size,
        symbols: graphResult.nodes.length,
        calls: totalCalls,
        skipped,
        languages: languageCounts,
      },
      fileHashes,
      analyzedFiles: [...extractions.keys()],
      warnings,
    };
  } catch (err) {
    console.error(`[recon] Worker pool error: ${err}. Falling back to sequential.`);
    return analyzeTreeSitter(rootDir, previousHashes, ignore);
  } finally {
    pool.terminate();
  }
}


/**
 * Multi-format Source Analyzer
 *
 * Ingests non-markdown source files into the same knowledge graph as code +
 * prose (multiformat-distill-01). Mirrors the markdown analyzer shape: a
 * directory walker (findSourceFiles) + a pure analyze fn (analyzeSource)
 * returning { nodes, searchText, warnings }, with the body kept OFF the
 * serialized node and carried in the search-text.json snapshot (the BM25 input).
 *
 * Two classes of file:
 *   text-native (.html / .htm / .txt / .yml / .yaml / .json) → a full searchable
 *       Source node. HTML is stripped to readable text; .txt is the whole file;
 *       yaml/json are parsed + flattened to key+value tokens. Body → searchText.
 *   binary (.pdf / .docx / .pptx / .xlsx) → a MINIMAL Source node (path +
 *       filename, NO body, no parse). Just enough to be discoverable and to be a
 *       resolvable `derived_from:` target — the searchable content arrives later
 *       via a D-distilled wiki page (PRD §3), not here.
 *
 * Emits one Source node per file — id `source:<file>`. No edges in this slice.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { NodeType, Language } from '../graph/types.js';
import type { Node } from '../graph/types.js';
import type { AnalyzerWarning } from './types.js';
import { IGNORE_DIRS, isLockfile } from './ignore.js';

// ─── Types ───────────────────────────────────────────────────────

export interface SourceFile {
  /** Project-relative path (POSIX separators). Used in the node id and `file`. */
  path: string;
  /** text-native files carry content for parsing; binary files do not. */
  kind: 'text' | 'binary';
  /** Lowercase extension incl. the dot, e.g. `.html`. */
  ext: string;
  /** Raw file content — present only for text-native files. */
  content?: string;
}

export interface SourceAnalysisResult {
  nodes: Node[];
  /**
   * nodeId → searchText (readable body). Persisted to search-text.json so the
   * body stays OFF the served graph node while remaining the lexical input.
   * Binary nodes have NO entry (no body was parsed).
   */
  searchText: Record<string, string>;
  /** Files whose per-file analysis threw and were SKIPPED (mirrors markdown). */
  warnings: AnalyzerWarning[];
}

// ─── Extensions ──────────────────────────────────────────────────

/** Text-native: read + index the body. */
export const TEXT_SOURCE_EXTENSIONS = new Set(['.html', '.htm', '.txt', '.yml', '.yaml', '.json']);
/** Binary: register a minimal node only (path, no body, no parse). */
export const BINARY_SOURCE_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx']);
/** Every extension this analyzer claims. */
export const SOURCE_EXTENSIONS = new Set([...TEXT_SOURCE_EXTENSIONS, ...BINARY_SOURCE_EXTENSIONS]);

const LANGUAGE_BY_EXT: Record<string, Language> = {
  '.html': Language.Html,
  '.htm': Language.Html,
  '.txt': Language.Text,
  '.yml': Language.Yaml,
  '.yaml': Language.Yaml,
  '.json': Language.Json,
  '.pdf': Language.Pdf,
  '.docx': Language.Docx,
  '.pptx': Language.Pptx,
  '.xlsx': Language.Xlsx,
};

// ─── File discovery ──────────────────────────────────────────────

// IGNORE_DIRS is shared with the markdown walker (./ignore.js) so prose and
// source agree on what is noise — including transient tool-dump dirs.

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

/**
 * Walk a directory tree for Source files (html/htm/txt + pdf/docx/pptx/xlsx),
 * returning each as a SourceFile. Text-native files are read into `content`;
 * binary files carry NO content (path only). Honors IGNORE_DIRS and config
 * path-prefix ignore patterns — same contract as findMarkdownFiles.
 *
 * `maxFileSize` (bytes) is the OPTIONAL OOM escape hatch (multiformat-distill-04):
 * text-native files strictly larger are skipped. DEFAULTS to Infinity = no cap —
 * the old hard 1 MB skip is gone. Binary files are never read regardless of size
 * (no parse, no OOM risk) so they are always registered as minimal nodes.
 */
export function findSourceFiles(
  rootDir: string,
  ignore: string[] = [],
  maxFileSize: number = Infinity,
): SourceFile[] {
  const out: SourceFile[] = [];

  const ignorePrefixes = ignore
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  const isIgnoredPath = (rel: string): boolean =>
    ignorePrefixes.some((p) => rel === p || rel.startsWith(p + '/'));

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const childAbs = join(dir, entry.name);
        const childRel = relative(rootDir, childAbs).replace(/\\/g, '/');
        if (isIgnoredPath(childRel)) continue;
        walk(childAbs);
        continue;
      }
      if (!entry.isFile()) continue;

      // Skip machine-generated lockfiles (package-lock.json / pnpm-lock.yaml /
      // *-lock.json) that would otherwise be indexed as .json/.yaml Source nodes.
      if (isLockfile(entry.name)) continue;

      const ext = getExtension(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      const absPath = join(dir, entry.name);
      const rel = relative(rootDir, absPath).replace(/\\/g, '/');

      if (BINARY_SOURCE_EXTENSIONS.has(ext)) {
        // Minimal node only — never read the bytes (no parse, no OOM risk).
        out.push({ path: rel, kind: 'binary', ext });
        continue;
      }

      // text-native: optional size-cap then read (the body becomes searchText).
      // Only stat when a finite cap is configured — the default (unlimited) path
      // skips the extra syscall and never excludes a file by size.
      if (Number.isFinite(maxFileSize)) {
        try {
          if (statSync(absPath).size > maxFileSize) continue;
        } catch {
          continue;
        }
      }
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }
      out.push({ path: rel, kind: 'text', ext, content });
    }
  };

  walk(rootDir);
  return out;
}

// ─── Parse helpers ───────────────────────────────────────────────

/** Package grouping for a source node = its directory ('' for repo-root files). */
function packageOf(path: string): string {
  const dir = dirname(path);
  return dir === '.' ? '' : dir;
}

/**
 * Strip C0 control characters from text that becomes node.name (a filename is
 * copied verbatim, so a raw ANSI escape could spoof the terminal when printed).
 * Built via fromCharCode to keep raw control bytes out of this source file.
 */
const C0_CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + ']', 'g');
function stripControlChars(text: string): string {
  return text.replace(C0_CONTROL, '');
}

/**
 * Remove <script>/<style> blocks (content + tags) in a SINGLE forward pass.
 *
 * The previous regex `/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi` is O(n²): an
 * unclosed <script> makes the lazy `[\s\S]*?` scan to end-of-string from each of
 * O(n) start positions (a ~1 MB unclosed-<script> doc took ~28 s — an availability
 * DoS, and the per-file try/catch catches throws, not hangs). This indexOf-based
 * scan visits every char at most once: find the next `<`, classify it as a
 * script/style open tag (word-boundary checked, mirroring the old `\b`), drop
 * through the matching close tag, and when no close tag exists cut from the open
 * tag to end-of-string. Linear, no backtracking, same removal semantics.
 */
function stripScriptStyle(html: string): string {
  const lower = html.toLowerCase();
  const tags = ['script', 'style'];
  let out = '';
  let i = 0;

  while (i < html.length) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    // Classify the tag at `lt`. `\b` after the name = the next char must be
    // non-word ([a-z0-9_]); NaN (end of string) is non-word, so it matches too.
    let matched: string | null = null;
    for (const tag of tags) {
      if (lower.startsWith(tag, lt + 1)) {
        const c = lower.charCodeAt(lt + 1 + tag.length);
        const isWord = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
        if (!isWord) {
          matched = tag;
          break;
        }
      }
    }

    if (!matched) {
      out += '<';
      i = lt + 1;
      continue;
    }

    out += ' '; // the dropped block becomes a single separator space
    const openEnd = lower.indexOf('>', lt);
    if (openEnd < 0) break; // unclosed open tag → cut to end-of-string
    const close = lower.indexOf('</' + matched, openEnd + 1);
    if (close < 0) break; // no closing tag → cut from open tag to end-of-string
    const closeEnd = lower.indexOf('>', close);
    if (closeEnd < 0) break; // closing tag never terminates → cut to end
    i = closeEnd + 1;
  }

  return out;
}

/**
 * Strip HTML to readable text. Drops <script>/<style> blocks (content + tags, via
 * the linear stripScriptStyle scan above) and comments, removes every remaining
 * tag, decodes the common named + numeric entities, and collapses whitespace. No
 * step uses a nested quantifier over an unbounded run, so a pathological document
 * can't backtrack.
 */
function stripHtml(html: string): string {
  return stripScriptStyle(html.replace(/<!--[\s\S]*?-->/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Flatten parsed structured data (YAML/JSON) into a flat key + value token
 * stream so BOTH keys and scalar values are lexically searchable, with the
 * structural punctuation ({}/[]/quotes/commas) dropped — clean BM25 input. Walks
 * maps (emit each key, then recurse the value) and sequences (recurse each item);
 * scalars stringify; null/undefined contribute nothing. A depth cap bounds the
 * recursion so pathologically nested data can't overflow the stack (the per-file
 * try/catch would contain a RangeError, but relying on stack overflow is fragile).
 */
const MAX_SERIALIZE_DEPTH = 256;
function serializeData(value: unknown, parts: string[] = [], depth = 0): string[] {
  if (depth > MAX_SERIALIZE_DEPTH) return parts;
  if (value === null || value === undefined) return parts;
  if (Array.isArray(value)) {
    for (const item of value) serializeData(item, parts, depth + 1);
  } else if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      parts.push(key);
      serializeData(val, parts, depth + 1);
    }
  } else {
    parts.push(String(value));
  }
  return parts;
}

/**
 * Reduce a text-native source's raw content to searchable body text per format.
 * Structured data (yaml/json) is PARSED then flattened to key+value tokens — a
 * malformed document throws here, which the per-file isolation in analyzeSource
 * turns into a warning + skip (no node). An empty/whitespace .json is treated as
 * an empty body (clean node, no warning) to match empty .yaml (which parses to
 * null). YAML is parsed via parseAllDocuments so multi-document manifests
 * (k8s/helm `---`-separated) index EVERY document, not just the first.
 * .txt is whole-file; html is stripped.
 */
function extractText(ext: string, raw: string): string {
  switch (ext) {
    case '.txt':
      return raw;
    case '.json':
      // Empty/whitespace JSON has no body — JSON.parse('') would throw, so guard
      // it to a clean empty node (parity with empty YAML parsing to null).
      return raw.trim() === '' ? '' : serializeData(JSON.parse(raw)).join(' ');
    case '.yml':
    case '.yaml': {
      const parts: string[] = [];
      for (const doc of parseAllDocuments(raw)) {
        // Surface a malformed document as a throw → per-file skip + warning.
        if (doc.errors.length > 0) throw doc.errors[0];
        serializeData(doc.toJSON(), parts);
      }
      return parts.join(' ');
    }
    default:
      return stripHtml(raw); // .html / .htm
  }
}

// ─── Analyzer ────────────────────────────────────────────────────

function analyzeSourceFile(file: SourceFile, out: SourceAnalysisResult): void {
  const rel = file.path;
  const id = `source:${rel}`;
  const language = LANGUAGE_BY_EXT[file.ext] ?? Language.Text;

  if (file.kind === 'binary') {
    // Minimal node: path + filename, NO body, no searchText entry.
    out.nodes.push({
      id,
      type: NodeType.Source,
      name: stripControlChars(basename(rel)),
      file: rel,
      startLine: 1,
      endLine: 1,
      language,
      package: packageOf(rel),
      exported: false,
    });
    return;
  }

  // text-native: parse the body OFF the node into searchText. A malformed
  // structured file (yaml/json) throws here → per-file skip + warning, no node.
  const raw = file.content ?? '';
  const text = extractText(file.ext, raw);

  out.nodes.push({
    id,
    type: NodeType.Source,
    name: stripControlChars(basename(rel)),
    file: rel,
    startLine: 1,
    endLine: raw.split('\n').length,
    language,
    package: packageOf(rel),
    exported: false,
  });

  const body = text.trim();
  if (body) out.searchText[id] = body;
}

/**
 * Analyze Source files into graph nodes + a searchText snapshot. Pure: depends
 * only on the given file contents (the walker is separate). Per-file isolation:
 * one file that throws records a warning and is SKIPPED, never aborting the pass
 * (mirrors analyzeMarkdown / the tree-sitter analyzer's warnings[]).
 */
export function analyzeSource(files: SourceFile[]): SourceAnalysisResult {
  const out: SourceAnalysisResult = { nodes: [], searchText: {}, warnings: [] };
  for (const file of files) {
    try {
      analyzeSourceFile(file, out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.warnings.push({ file: file.path, reason: message.split('\n')[0] });
    }
  }
  return out;
}

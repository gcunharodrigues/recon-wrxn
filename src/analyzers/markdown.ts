/**
 * Markdown / Prose Analyzer
 *
 * Ingests markdown into the same knowledge graph as code, so conceptual
 * queries surface documentation. Mirrors the cross-language analyzer shape:
 * a pure function returning { nodes, relationships } (plus a searchText
 * snapshot), bypassing tree-sitter (no markdown grammar) with its own walker.
 *
 * Parsed with the lean mdast core (mdast-util-from-markdown + the frontmatter
 * extension), NOT regex — a `#` inside a fenced code block would become a fake
 * heading — and NOT the full remark processor. See
 * docs/adr/0001-markdown-parser-mdast.md.
 *
 * Emits:
 *   Page    node per file    — id `md:page:<file>`
 *   Section node per heading  — id `md:section:<file>#<slug>@<line>` (the line
 *                               disambiguates repeated identical headings)
 *   Page -CONTAINS-> Section  edges
 *
 * Body text is kept OFF the serialized node and returned in `searchText` (the
 * persisted BM25 input — see docs/adr/0002-derived-search-index-persistence.md).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { toString as mdToString } from 'mdast-util-to-string';
import { NodeType, RelationshipType, Language } from '../graph/types.js';
import type { Node, Relationship } from '../graph/types.js';
import type { AnalyzerWarning } from './types.js';

// ─── Types ───────────────────────────────────────────────────────

export interface MarkdownFile {
  /** Project-relative path (POSIX separators). Used in node ids and the `file` field. */
  path: string;
  /** Raw markdown file content. */
  content: string;
}

export interface MarkdownAnalysisResult {
  nodes: Node[];
  relationships: Relationship[];
  /**
   * nodeId → searchText (heading + body). Persisted to search-text.json so the
   * body stays OFF the served graph node while remaining the lexical input.
   */
  searchText: Record<string, string>;
  /**
   * Files whose analysis threw (e.g. a pathological construct overflowing the
   * mdast parser) and were SKIPPED. Mirrors the tree-sitter analyzer's
   * per-file warnings[]: one bad file never aborts the whole pass.
   */
  warnings: AnalyzerWarning[];
}

// ─── File discovery ──────────────────────────────────────────────

// Mirrors the tree-sitter analyzer's IGNORE_DIRS so prose and code agree on
// what is noise. Meaningful dot-dirs (.claude/, .wrxn/) are intentionally NOT
// here — the wiki lives there and must be walked.
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.recon-wrxn', '.reference', 'vendor', 'target',
  'build', 'dist', 'out', '.venv', 'venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.cargo', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '.github', '.husky', '.next', '.turbo', '.cache', '.aiox',
]);

const MAX_FILE_SIZE = 1_000_000; // 1 MB — match the tree-sitter walker's cap.

/**
 * Walk a directory tree for `.md` files, returning each as { path, content }.
 * Markdown bypasses the tree-sitter walker (no markdown grammar), so it needs
 * its own discovery. Honors IGNORE_DIRS and config path-prefix ignore patterns.
 */
export function findMarkdownFiles(rootDir: string, ignore: string[] = []): MarkdownFile[] {
  const out: MarkdownFile[] = [];

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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const absPath = join(dir, entry.name);
        try {
          if (statSync(absPath).size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }
        let content: string;
        try {
          content = readFileSync(absPath, 'utf-8');
        } catch {
          continue;
        }
        out.push({ path: relative(rootDir, absPath).replace(/\\/g, '/'), content });
      }
    }
  };

  walk(rootDir);
  return out;
}

// ─── Parse helpers ───────────────────────────────────────────────

const MICROMARK_EXTENSIONS = [frontmatter(['yaml'])];
const MDAST_EXTENSIONS = [frontmatterFromMarkdown(['yaml'])];

/** Slugify a heading into an id-safe fragment (the `#<slug>` part of a Section id). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Extract a `title:` value from raw YAML frontmatter (no YAML dep — one field). */
function frontmatterTitle(yaml: string): string | undefined {
  const m = yaml.match(/^title:\s*(.+)$/m);
  if (!m) return undefined;
  const value = m[1].trim().replace(/^["']|["']$/g, '').trim();
  return value || undefined;
}

/** Package grouping for a prose node = its directory ('' for repo-root files). */
function packageOf(path: string): string {
  const dir = dirname(path);
  return dir === '.' ? '' : dir;
}

/**
 * Strip C0 control characters (0x00–0x1F, incl. ESC 0x1b) from text that becomes
 * node.name. A heading or frontmatter title is copied verbatim from a .md, so a
 * raw ANSI escape could spoof the terminal when the name is printed. The
 * searchText body is left intact (it is not surfaced as a label). The class is
 * built via fromCharCode to keep raw control bytes out of this source file.
 */
const C0_CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + ']', 'g');
function stripControlChars(text: string): string {
  return text.replace(C0_CONTROL, '');
}

// ─── Analyzer ────────────────────────────────────────────────────

function analyzeFile(file: MarkdownFile, out: MarkdownAnalysisResult): void {
  const tree = fromMarkdown(file.content, {
    extensions: MICROMARK_EXTENSIONS,
    mdastExtensions: MDAST_EXTENSIONS,
  });

  const rel = file.path;
  const pageId = `md:page:${rel}`;
  const pkg = packageOf(rel);

  let title: string | undefined;
  const pageParts: string[] = [];

  // Section nodes in document order; body blocks are attributed to the current
  // (most recent) heading until the next heading, regardless of depth.
  const sections: Array<{ node: Node; parts: string[] }> = [];
  let current: { node: Node; parts: string[] } | null = null;

  for (const child of tree.children) {
    if (child.type === 'yaml') {
      const t = frontmatterTitle(child.value);
      if (t) title = t;
      continue;
    }

    if (child.type === 'heading') {
      const text = mdToString(child);
      const line = child.position?.start?.line ?? 0;
      const node: Node = {
        id: `md:section:${rel}#${slugify(text)}@${line}`,
        type: NodeType.Section,
        name: stripControlChars(text),
        file: rel,
        startLine: line,
        endLine: line,
        language: Language.Markdown,
        package: pkg,
        exported: false,
      };
      current = { node, parts: [text] };
      sections.push(current);
      pageParts.push(text);
      continue;
    }

    const text = mdToString(child);
    if (text) {
      pageParts.push(text);
      if (current) current.parts.push(text);
    }
  }

  const pageNode: Node = {
    id: pageId,
    type: NodeType.Page,
    name: stripControlChars(title ?? basename(rel)),
    file: rel,
    startLine: 1,
    endLine: file.content.split('\n').length,
    language: Language.Markdown,
    package: pkg,
    exported: false,
  };
  out.nodes.push(pageNode);
  out.searchText[pageId] = [title, ...pageParts].filter(Boolean).join(' ');

  for (const section of sections) {
    out.nodes.push(section.node);
    out.relationships.push({
      id: `${pageId}-CONTAINS-${section.node.id}`,
      type: RelationshipType.CONTAINS,
      sourceId: pageId,
      targetId: section.node.id,
      confidence: 1.0,
    });
    out.searchText[section.node.id] = section.parts.join(' ');
  }
}

/**
 * Analyze markdown files into prose graph nodes + edges + a searchText snapshot.
 * Pure: depends only on the given file contents (the walker is separate).
 */
export function analyzeMarkdown(files: MarkdownFile[]): MarkdownAnalysisResult {
  const out: MarkdownAnalysisResult = { nodes: [], relationships: [], searchText: {}, warnings: [] };
  for (const file of files) {
    // Isolate each file: a throw (e.g. RangeError from a pathological construct
    // the mdast parser can't handle) records a warning and SKIPS that file
    // instead of aborting the index pass. analyzeFile commits its nodes/edges to
    // `out` only at the end (after the throw-prone parse + walk), so a failed
    // file leaves `out` untouched — the skip is atomic.
    try {
      analyzeFile(file, out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.warnings.push({ file: file.path, reason: message.split('\n')[0] });
    }
  }
  return out;
}

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
import { IGNORE_DIRS } from './ignore.js';

// ─── Types ───────────────────────────────────────────────────────

export interface MarkdownFile {
  /** Project-relative path (POSIX separators). Used in node ids and the `file` field. */
  path: string;
  /** Raw markdown file content. */
  content: string;
}

/**
 * A RAW doc→code signal harvested from a page, NOT yet resolved to a code node.
 * Resolution to a real node id happens in the edge resolver (the only component
 * with the code graph) — see doc-edges.ts. Two high-precision kinds:
 *   `anchor`   — a frontmatter `derived_from:` entry: a graph node id, a path,
 *                or `path#symbol` (an optional trailing `@sha` is tolerated).
 *   `citation` — an explicit `file.ext:line` reference in the prose body.
 */
export interface DocCitation {
  /** The prose node that owns the signal (always the Page). */
  sourceId: string;
  /** Raw reference text, resolved later against the code graph. */
  ref: string;
  kind: 'anchor' | 'citation';
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
   * Raw doc→code signals (derived_from anchors + file:line citations) harvested
   * from every page, for the edge resolver to turn into DOCUMENTED_BY edges.
   */
  citations: DocCitation[];
  /**
   * Files whose analysis threw (e.g. a pathological construct overflowing the
   * mdast parser) and were SKIPPED. Mirrors the tree-sitter analyzer's
   * per-file warnings[]: one bad file never aborts the whole pass.
   */
  warnings: AnalyzerWarning[];
}

// ─── File discovery ──────────────────────────────────────────────

// IGNORE_DIRS is shared with the source walker (./ignore.js) so prose and
// source agree on what is noise.

/**
 * Walk a directory tree for `.md` files, returning each as { path, content }.
 * Markdown bypasses the tree-sitter walker (no markdown grammar), so it needs
 * its own discovery. Honors IGNORE_DIRS and config path-prefix ignore patterns.
 *
 * `maxFileSize` (bytes) is the OPTIONAL OOM escape hatch (multiformat-distill-04):
 * files strictly larger are skipped. DEFAULTS to Infinity = no cap — the old hard
 * 1 MB skip is gone, so a >1 MB doc is indexed unless an install opts into a cap.
 */
export function findMarkdownFiles(
  rootDir: string,
  ignore: string[] = [],
  maxFileSize: number = Infinity,
): MarkdownFile[] {
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
        // Only stat when a finite cap is configured — the default (unlimited)
        // path skips the extra syscall and never excludes a file by size.
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

/**
 * Strip a YAML inline comment + surrounding quotes from one scalar. A comment is
 * ` #...` (whitespace before `#`), so `path#symbol` (no space before `#`) is
 * preserved while `[a, b]  # note` loses its trailing comment.
 */
function cleanScalar(s: string): string {
  return s.replace(/\s#.*$/, '').trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Extract `derived_from:` entries from raw YAML frontmatter (no YAML dep). The
 * documented convention is a list of paths and/or graph node ids:
 *   derived_from: [src/a.ts, ts:func:login]   # inline flow list
 *   derived_from: src/a.ts#login              # scalar (path / path#symbol / id)
 *   derived_from:                             # block sequence
 *     - src/a.ts
 *     - ts:func:login
 * Returns each entry verbatim (resolution happens in the edge resolver).
 */
function parseDerivedFrom(yaml: string): string[] {
  const lines = yaml.split('\n');
  const idx = lines.findIndex((l) => /^derived_from\s*:/.test(l));
  if (idx === -1) return [];

  const head = cleanScalar(lines[idx].replace(/^derived_from\s*:/, ''));
  const out: string[] = [];

  if (head.startsWith('[') && head.endsWith(']')) {
    for (const part of head.slice(1, -1).split(',')) {
      const v = cleanScalar(part);
      if (v) out.push(v);
    }
  } else if (head) {
    out.push(head);
  } else {
    // Block sequence: consecutive `- item` lines beneath the key.
    for (let i = idx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s*(.+)$/);
      if (!m) break;
      const v = cleanScalar(m[1]);
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * Extract the `synced_to:` provenance watermark from raw YAML frontmatter (no
 * YAML dep). A single scalar carried verbatim — the source version (an AST
 * fingerprint, sync-02) a derived page was last reconciled against:
 *   synced_to: ast:abc123              # opaque fingerprint string
 *   synced_to: src/a.ts#login@deadbeef # path#symbol@sha is stored verbatim too
 * R1 stores whatever string is present; no fingerprint computation, no drift
 * compare (sync-02/03). Returns undefined when absent — no default, no throw.
 */
function parseSyncedTo(yaml: string): string | undefined {
  const lines = yaml.split('\n');
  const idx = lines.findIndex((l) => /^synced_to\s*:/.test(l));
  if (idx === -1) return undefined;
  const v = cleanScalar(lines[idx].replace(/^synced_to\s*:/, ''));
  return v || undefined;
}

/**
 * `file.ext:line` citations in prose body. Liberal by design: extraction casts a
 * wide net; precision is enforced later, where the edge resolver drops any
 * candidate that does not match a real code node (so a stray `host.com:80` makes
 * no edge). Requires a path with an extension followed by `:<digits>`.
 */
const CITATION_RE = /([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_]+):(\d+)/g;

/**
 * Per-token length cap for citation harvesting. Real `file.ext:line` citations are
 * whitespace-free and far shorter than this; any longer token is skipped so the
 * citation regex — which backtracks quadratically on a long run with no terminating
 * `:<digit>` (a ≤1MB token took >120s) — can never be driven into a ReDoS hang by a
 * single pathological .md during `index` / `serve` auto-index / the watcher.
 */
const MAX_CITATION_TOKEN = 256;

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
  let syncedTo: string | undefined;
  const pageParts: string[] = [];

  // Section nodes in document order; body blocks are attributed to the current
  // (most recent) heading until the next heading, regardless of depth.
  const sections: Array<{ node: Node; parts: string[] }> = [];
  let current: { node: Node; parts: string[] } | null = null;

  for (const child of tree.children) {
    if (child.type === 'yaml') {
      const t = frontmatterTitle(child.value);
      if (t) title = t;
      const w = parseSyncedTo(child.value);
      if (w) syncedTo = w;
      for (const ref of parseDerivedFrom(child.value)) {
        out.citations.push({ sourceId: pageId, ref, kind: 'anchor' });
      }
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

    // Harvest `file:line` citations from prose body — but NOT from fenced code
    // blocks, whose example code would manufacture false citations. Matched per
    // whitespace-delimited token (a real citation has no whitespace), skipping any
    // over-long token, so a pathological no-match run can't backtrack quadratically.
    if (text && child.type !== 'code') {
      for (const token of text.split(/\s+/)) {
        if (token.length > MAX_CITATION_TOKEN) continue;
        for (const m of token.matchAll(CITATION_RE)) {
          out.citations.push({ sourceId: pageId, ref: `${m[1]}:${m[2]}`, kind: 'citation' });
        }
      }
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
  // Carry the provenance watermark only when declared — a page without
  // `synced_to:` leaves the field absent (sync-03 reads that as `unwatermarked`,
  // distinct from stale). No default.
  if (syncedTo) pageNode.syncedTo = stripControlChars(syncedTo);
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
  const out: MarkdownAnalysisResult = { nodes: [], relationships: [], searchText: {}, citations: [], warnings: [] };
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

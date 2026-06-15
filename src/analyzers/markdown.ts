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

import { basename, dirname } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { toString as mdToString } from 'mdast-util-to-string';
import { NodeType, RelationshipType, Language } from '../graph/types.js';
import type { Node, Relationship } from '../graph/types.js';

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
        name: text,
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
    name: title ?? basename(rel),
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
  const out: MarkdownAnalysisResult = { nodes: [], relationships: [], searchText: {} };
  for (const file of files) {
    analyzeFile(file, out);
  }
  return out;
}

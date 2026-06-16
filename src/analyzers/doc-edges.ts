/**
 * Doc↔Code Edge Resolver
 *
 * Turns the RAW doc→code signals harvested by the markdown analyzer
 * (`DocCitation[]`) into `DOCUMENTED_BY` relationships against the live code
 * graph. This is the only prose component that needs the code graph, so it is
 * kept separate from the pure `analyzeMarkdown` parser and run at index time,
 * after both code and prose nodes are in the graph (see commands.ts ingestProse).
 *
 * Precision-first (report.md): only two high-precision signals resolve —
 *   • anchor   `derived_from:` entry — a graph node id, a path (→ File node),
 *              or `path#symbol` (→ that symbol); a trailing `@sha` is tolerated.
 *   • citation `file.ext:line` — the innermost code symbol whose line range
 *              contains the cited line.
 * NO fuzzy symbol-name matching (61% false-positive). An unresolvable signal
 * produces NO edge — a wrong edge misleads `recon_explain` worse than a missing
 * one.
 *
 * DOCUMENTED_BY is directed Prose → Code: sourceId = Page, targetId = symbol.
 */

import { KnowledgeGraph } from '../graph/graph.js';
import { NodeType, RelationshipType, Language } from '../graph/types.js';
import type { Node, Relationship } from '../graph/types.js';
import type { DocCitation } from './markdown.js';

/** Prose never documents prose — only code nodes are valid DOCUMENTED_BY targets. */
function isCodeTarget(node: Node): boolean {
  return node.language !== Language.Markdown;
}

/** A doc-supplied path → the project-relative POSIX form `node.file` uses. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** The named symbol defined in `path` (prefer exported, then earliest, on ties). */
function pickSymbol(inFile: Node[], symbol: string): Node | undefined {
  const matches = inFile.filter((n) => n.name === symbol);
  if (matches.length <= 1) return matches[0];
  const exported = matches.filter((n) => n.exported);
  const pool = exported.length > 0 ? exported : matches;
  return [...pool].sort((a, b) => a.startLine - b.startLine)[0];
}

/** Resolve a `derived_from:` anchor to a single code node, or undefined. */
function resolveAnchor(
  graph: KnowledgeGraph,
  byFile: Map<string, Node[]>,
  ref: string,
): Node | undefined {
  // 1. A direct graph node id (the documented `ts:func:login` form).
  const direct = graph.getNode(ref);
  if (direct) return isCodeTarget(direct) ? direct : undefined;

  // 2. Tolerate a trailing `@sha` provenance watermark on a path#symbol anchor.
  let r = ref;
  const hash = r.indexOf('#');
  if (hash !== -1) {
    const at = r.indexOf('@', hash);
    if (at !== -1) r = r.slice(0, at);
    const path = normalizePath(r.slice(0, hash));
    return pickSymbol(byFile.get(path) ?? [], r.slice(hash + 1));
  }

  // 3. A bare path → the File node for it, OR the raw Source node a distilled
  //    page was `derived_from:` (id `source:<relpath>`, e.g. a .pdf). Both are
  //    whole-file anchors; the provenance loop (multiformat-distill-07) needs
  //    Source so `derived_from` closes back to the raw artifact.
  const path = normalizePath(r);
  return (byFile.get(path) ?? []).find(
    (n) => n.type === NodeType.File || n.type === NodeType.Source,
  );
}

/** Resolve a `file:line` citation to the innermost containing code symbol. */
function resolveCitation(byFile: Map<string, Node[]>, ref: string): Node | undefined {
  const m = ref.match(/^(.*):(\d+)$/);
  if (!m) return undefined;
  const path = normalizePath(m[1]);
  const line = parseInt(m[2], 10);

  // A Source node carries a non-Markdown Language so it lands in byFile, and its
  // 1..N line span could "contain" a cited line — but a Source is a raw artifact,
  // not a code symbol, so a `file:line` citation must never resolve to it
  // (multiformat-distill-07).
  const containing = (byFile.get(path) ?? []).filter(
    (n) =>
      n.type !== NodeType.Source &&
      n.endLine > 0 &&
      n.startLine <= line &&
      n.endLine >= line,
  );
  if (containing.length === 0) return undefined;
  // Innermost = latest start, then tightest end.
  return [...containing].sort(
    (a, b) => b.startLine - a.startLine || a.endLine - b.endLine,
  )[0];
}

/**
 * Resolve doc→code citations into DOCUMENTED_BY edges against the code graph.
 * Duplicate (source, target) pairs collapse to one edge.
 */
export function resolveDocEdges(
  graph: KnowledgeGraph,
  citations: DocCitation[],
): Relationship[] {
  // Index code nodes by file once: each resolution is then O(nodes-in-file).
  const byFile = new Map<string, Node[]>();
  for (const node of graph.nodes.values()) {
    if (!isCodeTarget(node)) continue;
    const arr = byFile.get(node.file);
    if (arr) arr.push(node);
    else byFile.set(node.file, [node]);
  }

  const edges: Relationship[] = [];
  const seen = new Set<string>();
  for (const c of citations) {
    const target = c.kind === 'anchor'
      ? resolveAnchor(graph, byFile, c.ref)
      : resolveCitation(byFile, c.ref);
    if (!target) continue;

    const id = `${c.sourceId}-DOCUMENTED_BY-${target.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({
      id,
      type: RelationshipType.DOCUMENTED_BY,
      sourceId: c.sourceId,
      targetId: target.id,
      confidence: 1.0,
    });
  }
  return edges;
}

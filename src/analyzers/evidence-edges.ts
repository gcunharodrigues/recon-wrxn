/**
 * Evidence↔Graph Edge Resolver (citation-recon R2, #19)
 *
 * Turns the kernel's FROZEN evidence-frontmatter contract (wrxn-kernel #33) —
 * `evidence:{ session, commit, symbols }` harvested per page by analyzeMarkdown
 * (`EvidenceSignal[]`) — into citation edges against the live graph. Mirrors
 * `resolveDocEdges`: the only prose component that needs the code + session graph,
 * so it is kept separate from the pure markdown parser and run at index time,
 * AFTER code, prose AND R1's SessionEvent nodes are in the graph (commands.ts
 * ingestProse). It draws:
 *
 *   • EVIDENCED_BY  Page → each SessionEvent of `evidence.session`. R1 emits one
 *                   SessionEvent node per record and carries the session id as
 *                   `node.package`; the session has no aggregate node, so the page
 *                   is linked to each event of that session. The `evidence.commit`
 *                   sha rides on these edges as a `metadata.commit` watermark
 *                   (there is no commit node), tagged `commitResolved` iff the sha
 *                   is syntactically valid — see SHA_RE.
 *   • DOCUMENTED_BY Page → the code node each `evidence.symbols` entry resolves to.
 *                   These entries are .touched paths/symbols, i.e. exactly the
 *                   `derived_from:` anchor shape, so resolution REUSES resolveDocEdges
 *                   wholesale (precision-first: a bare name / missing path → no edge).
 *                   This populates the existing-but-empty DOCUMENTED_BY (recon-wrxn#16)
 *                   from fact-derived evidence frontmatter.
 *
 * Tag (deterministic, index-time): every edge this resolver emits is minted ONLY
 * when its target node provably exists (doc-edges precision discipline → no
 * dangling/heuristic edges), so each carries `metadata.tag = 'resolved'`. The
 * `inferred` band is carried by the commit watermark (`commitResolved: false`):
 * a malformed sha is the one unverified link, KEPT on the edge so the page's
 * commit citation stays visible rather than silently dropped.
 *
 * Fail-soft + idempotent: unresolvable evidence (no matching session/symbol) adds
 * NO edge and NEVER throws; re-running over the same graph + signals yields the
 * identical edges (deterministic node-iteration + signal order, deduped by id).
 */

import { KnowledgeGraph } from '../graph/graph.js';
import { NodeType, RelationshipType } from '../graph/types.js';
import type { Node, Relationship } from '../graph/types.js';
import type { DocCitation, EvidenceSignal } from './markdown.js';
import { resolveDocEdges } from './doc-edges.js';

/**
 * Confidence for an evidence edge. Fact-derived from the kernel's frozen
 * frontmatter contract (stronger than a hand-written citation) AND the target is
 * verified-present in the graph — but still doc-ASSERTED (the page claims it), so
 * < 1.0, matching doc-edges' ANCHOR_CONFIDENCE band.
 */
export const EVIDENCE_CONFIDENCE = 0.9;

/** A syntactically valid git sha: 7–40 hex chars. Deterministic, no git IO (keeps the resolver pure). */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Resolve evidence-frontmatter signals into EVIDENCED_BY + DOCUMENTED_BY edges.
 * Duplicate (source, target) pairs collapse to one edge.
 */
export function resolveEvidenceEdges(
  graph: KnowledgeGraph,
  signals: EvidenceSignal[],
): Relationship[] {
  const edges: Relationship[] = [];
  const seen = new Set<string>();

  // EVIDENCED_BY: index SessionEvent nodes by their session id (R1: node.package).
  const eventsBySession = new Map<string, Node[]>();
  for (const node of graph.nodes.values()) {
    if (node.type !== NodeType.SessionEvent) continue;
    const arr = eventsBySession.get(node.package);
    if (arr) arr.push(node);
    else eventsBySession.set(node.package, [node]);
  }

  for (const sig of signals) {
    if (!sig.session) continue;
    const events = eventsBySession.get(sig.session) ?? [];
    // The evidence.commit sha is a watermark on these session edges (no commit
    // node exists). Carried verbatim when declared; commitResolved tags it
    // resolved iff it is a syntactically valid sha, else inferred (still kept so
    // the page's commit citation stays visible — fail-soft, never dropped).
    const commit = sig.commit;
    for (const ev of events) {
      const id = `${sig.sourceId}-EVIDENCED_BY-${ev.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const metadata: Relationship['metadata'] = { tag: 'resolved' };
      if (commit) {
        metadata.commit = commit;
        metadata.commitResolved = SHA_RE.test(commit);
      }
      edges.push({
        id,
        type: RelationshipType.EVIDENCED_BY,
        sourceId: sig.sourceId,
        targetId: ev.id,
        confidence: EVIDENCE_CONFIDENCE,
        metadata,
      });
    }
  }

  // DOCUMENTED_BY: evidence.symbols are .touched paths/symbols — exactly the
  // `derived_from:` anchor shape, so REUSE resolveDocEdges' precision-first
  // resolution wholesale (node id / path / path#symbol → real node; bare name or
  // missing path → no edge). It returns deduped, correctly-typed Page→code edges;
  // we only stamp the index-time tag (the target provably exists → resolved).
  const symbolAnchors: DocCitation[] = [];
  for (const sig of signals) {
    for (const ref of sig.symbols) symbolAnchors.push({ sourceId: sig.sourceId, ref, kind: 'anchor' });
  }
  for (const edge of resolveDocEdges(graph, symbolAnchors)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    edge.metadata = { ...edge.metadata, tag: 'resolved' };
    edges.push(edge);
  }

  return edges;
}

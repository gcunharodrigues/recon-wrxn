/**
 * recon_drift — the computable stale set (sync-03)
 *
 * A PURE indexed-graph compare: for each prose Page that declares a `derived_from`
 * anchor (a DOCUMENTED_BY edge to a code symbol) AND carries a `synced_to`
 * watermark (sync-01), the page is STALE iff the target symbol's CURRENT
 * `fingerprint` (sync-02) differs from the watermark — fingerprint-vs-fingerprint
 * (ADR-0004 pin). No `git`, no `recon_changes`, no filesystem read: only the
 * already-indexed graph is traversed, so the query is HTTP-door-safe (sync-03 AC3).
 *
 * The doc→source resolution is the one the edge resolver already cached: a
 * `path#symbol` anchor was resolved to the SPECIFIC symbol node at index time
 * (doc-edges.ts `resolveAnchor` → `pickSymbol`), so the DOCUMENTED_BY edge target
 * IS that exact symbol — never a whole file or an enclosing class whose
 * fingerprint would subsume its methods' subtrees (sync-03 AC4, R2 finding).
 *
 * Only `derived_from` ANCHOR edges are provenance; an incidental `file:line` body
 * citation (the weaker DOCUMENTED_BY signal) is NOT a watermarked source and is
 * excluded via the confidence discriminator.
 */

import type { KnowledgeGraph } from '../graph/graph.js';
import { NodeType, RelationshipType } from '../graph/types.js';
import type { Node } from '../graph/types.js';
import { ANCHOR_CONFIDENCE } from '../analyzers/doc-edges.js';

/** A watermarked derived page whose source symbol's fingerprint has moved. */
export interface StaleEntry {
  page: string;        // the doc page (node name)
  pageFile: string;    // the page's file path
  symbol: string;      // the SPECIFIC source symbol the anchor names
  symbolFile: string;
  symbolLine: number;
  syncedTo: string;    // the watermark the page was last reconciled against
  current: string;     // the source symbol's current fingerprint
}

/** A derived page that declares provenance but carries no `synced_to` watermark. */
export interface UnwatermarkedEntry {
  page: string;
  pageFile: string;
  symbol: string;
  symbolFile: string;
  symbolLine: number;
}

export interface DriftReport {
  stale: StaleEntry[];
  unwatermarked: UnwatermarkedEntry[];
  fresh: number; // count of watermarked (page, symbol) pairs whose fingerprint matches
}

/**
 * Compute the drift report from the indexed graph alone (sync-03 AC2/AC3/AC5).
 */
export function computeDrift(graph: KnowledgeGraph): DriftReport {
  const stale: StaleEntry[] = [];
  const unwatermarked: UnwatermarkedEntry[] = [];
  let fresh = 0;

  for (const node of graph.nodes.values()) {
    if (node.type !== NodeType.Page) continue;

    // Declared provenance only: the `derived_from` anchor edges, not incidental
    // `file:line` citation edges (which carry no watermark). The edge target is
    // the exact symbol the anchor resolved to at index time.
    const targets: Node[] = graph
      .getOutgoing(node.id, RelationshipType.DOCUMENTED_BY)
      .filter((e) => e.confidence === ANCHOR_CONFIDENCE)
      .map((e) => graph.getNode(e.targetId))
      .filter((n): n is Node => Boolean(n));

    if (targets.length === 0) continue; // not a declared-derived page → untracked

    // No watermark → reported in the distinct `unwatermarked` bucket, never stale
    // and never dropped (sync-03 AC5).
    if (node.syncedTo === undefined) {
      for (const t of targets) {
        unwatermarked.push({
          page: node.name,
          pageFile: node.file,
          symbol: t.name,
          symbolFile: t.file,
          symbolLine: t.startLine,
        });
      }
      continue;
    }

    for (const t of targets) {
      // A whole-file anchor (File/Source target) has no symbol fingerprint to
      // compare against — skip it rather than guess drift.
      if (t.fingerprint === undefined) continue;
      if (t.fingerprint === node.syncedTo) {
        fresh++;
      } else {
        stale.push({
          page: node.name,
          pageFile: node.file,
          symbol: t.name,
          symbolFile: t.file,
          symbolLine: t.startLine,
          syncedTo: node.syncedTo,
          current: t.fingerprint,
        });
      }
    }
  }

  return { stale, unwatermarked, fresh };
}

/**
 * Render a drift report as the agent-facing markdown the recon_drift tool returns.
 * Names the page, the specific source symbol, and `synced_to` vs the current
 * fingerprint for every stale entry (sync-03 AC4).
 */
export function formatDrift(report: DriftReport): string {
  const { stale, unwatermarked, fresh } = report;

  const lines: string[] = [
    '# Drift Report',
    '',
    `**Stale:** ${stale.length} | **Unwatermarked:** ${unwatermarked.length} | **Fresh:** ${fresh}`,
    '',
  ];

  if (stale.length === 0 && unwatermarked.length === 0) {
    lines.push(
      fresh > 0
        ? `_No drift: ${fresh} watermarked derived page(s) fresh._`
        : '_No drift: no watermarked derived pages tracked._',
    );
    return lines.join('\n');
  }

  if (stale.length > 0) {
    lines.push(`## Stale (${stale.length})`, '');
    for (const s of stale) {
      lines.push(
        `- **${s.symbol}** drifted — \`${s.page}\` (\`${s.pageFile}\`) was synced to ` +
        `\`${s.syncedTo}\`, but \`${s.symbolFile}:${s.symbolLine}\` is now \`${s.current}\``,
      );
    }
    lines.push('');
  }

  if (unwatermarked.length > 0) {
    lines.push(`## Unwatermarked (${unwatermarked.length})`, '');
    for (const u of unwatermarked) {
      lines.push(
        `- **${u.symbol}** — \`${u.page}\` (\`${u.pageFile}\`) is derived_from ` +
        `\`${u.symbolFile}:${u.symbolLine}\` but carries no \`synced_to\` watermark`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

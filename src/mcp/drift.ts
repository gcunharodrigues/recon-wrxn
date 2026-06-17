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
import { CITATION_CONFIDENCE } from '../analyzers/doc-edges.js';

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

/**
 * A derived page whose `derived_from` anchor resolves to MORE THAN ONE source
 * symbol. Drift for a multi-target page is unsupported (sync-01 defers it): a
 * single `synced_to` watermark can't be compared against several fingerprints
 * without falsely flagging all-but-one stale, so the whole page is reported here
 * rather than mis-compared.
 */
export interface MultiAnchorEntry {
  page: string;
  pageFile: string;
  symbols: string[]; // every target symbol name the anchor resolved to
  syncedTo?: string; // the page's watermark, when it carries one
}

/**
 * A watermarked derived page whose single anchor target has no fingerprint to
 * compare against — a whole-file File node or a raw Source artifact (e.g. a
 * distilled PDF). Reported rather than silently dropped (sync-03 AC5).
 */
export interface UncomparableEntry {
  page: string;
  pageFile: string;
  symbol: string;
  symbolFile: string;
  symbolLine: number;
  reason: string;
}

export interface DriftReport {
  stale: StaleEntry[];
  unwatermarked: UnwatermarkedEntry[];
  multiAnchor: MultiAnchorEntry[];
  uncomparable: UncomparableEntry[];
  fresh: number; // count of watermarked (page, symbol) pairs whose fingerprint matches
}

/**
 * Compute the drift report from the indexed graph alone (sync-03 AC2/AC3/AC5).
 */
export function computeDrift(graph: KnowledgeGraph): DriftReport {
  const stale: StaleEntry[] = [];
  const unwatermarked: UnwatermarkedEntry[] = [];
  const multiAnchor: MultiAnchorEntry[] = [];
  const uncomparable: UncomparableEntry[] = [];
  let fresh = 0;

  for (const node of graph.nodes.values()) {
    if (node.type !== NodeType.Page) continue;

    // Declared provenance only: the `derived_from` anchor edges, not incidental
    // `file:line` citation edges (which carry no watermark). The edge target is
    // the exact symbol the anchor resolved to at index time.
    const targets: Node[] = graph
      .getOutgoing(node.id, RelationshipType.DOCUMENTED_BY)
      .filter((e) => e.confidence > CITATION_CONFIDENCE)
      .map((e) => graph.getNode(e.targetId))
      .filter((n): n is Node => Boolean(n));

    if (targets.length === 0) continue; // not a declared-derived page → untracked

    // More than one anchor target → a single `synced_to` watermark can't be
    // compared against several fingerprints without falsely marking all-but-one
    // stale, so the whole page goes to the distinct `multiAnchor` bucket (sync-01
    // defers multi-target drift) — never to stale/fresh/unwatermarked.
    if (targets.length > 1) {
      multiAnchor.push({
        page: node.name,
        pageFile: node.file,
        symbols: targets.map((t) => t.name),
        syncedTo: node.syncedTo,
      });
      continue;
    }

    // No watermark — absent OR empty string — goes to the distinct `unwatermarked`
    // bucket, never stale and never dropped (sync-03 AC5).
    if (!node.syncedTo) {
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
      // A whole-file anchor (File node) or raw Source artifact has no symbol
      // fingerprint to compare against — report it as uncomparable rather than
      // silently dropping the watermarked page from every bucket (sync-03 AC5).
      if (t.fingerprint === undefined) {
        uncomparable.push({
          page: node.name,
          pageFile: node.file,
          symbol: t.name,
          symbolFile: t.file,
          symbolLine: t.startLine,
          reason: 'no fingerprint / whole-file target',
        });
        continue;
      }
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

  return { stale, unwatermarked, multiAnchor, uncomparable, fresh };
}

/**
 * Render a drift report as the agent-facing markdown the recon_drift tool returns.
 * Names the page, the specific source symbol, and `synced_to` vs the current
 * fingerprint for every stale entry (sync-03 AC4).
 */
export function formatDrift(report: DriftReport): string {
  const { stale, unwatermarked, multiAnchor, uncomparable, fresh } = report;

  const lines: string[] = [
    '# Drift Report',
    '',
    `**Stale:** ${stale.length} | **Unwatermarked:** ${unwatermarked.length} | ` +
      `**Multi-anchor:** ${multiAnchor.length} | **Uncomparable:** ${uncomparable.length} | ` +
      `**Fresh:** ${fresh}`,
    '',
  ];

  if (
    stale.length === 0 &&
    unwatermarked.length === 0 &&
    multiAnchor.length === 0 &&
    uncomparable.length === 0
  ) {
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

  if (multiAnchor.length > 0) {
    lines.push(`## Multi-anchor — unsupported (${multiAnchor.length})`, '');
    for (const m of multiAnchor) {
      lines.push(
        `- \`${m.page}\` (\`${m.pageFile}\`) is derived_from ${m.symbols.length} symbols ` +
        `(${m.symbols.map((s) => `**${s}**`).join(', ')}) — multi-target drift is not compared`,
      );
    }
    lines.push('');
  }

  if (uncomparable.length > 0) {
    lines.push(`## Uncomparable (${uncomparable.length})`, '');
    for (const u of uncomparable) {
      lines.push(
        `- **${u.symbol}** — \`${u.page}\` (\`${u.pageFile}\`) is derived_from ` +
        `\`${u.symbolFile}:${u.symbolLine}\` (${u.reason})`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

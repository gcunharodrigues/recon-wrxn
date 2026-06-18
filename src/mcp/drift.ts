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

/**
 * A watermarked derived page whose `derived_from` source symbol is ABSENT from the
 * graph — RENAMED or DELETED, so the symbol node + its DOCUMENTED_BY anchor edge
 * were removed (graph.ts `removeNodesByFile`), or a re-index left the anchor
 * unresolvable (doc-edges.ts `resolveAnchor` → no edge), or an anchor edge dangles
 * to a now-missing node. The page still carries a `synced_to` watermark, so it is
 * NEITHER `stale` (no live fingerprint to compare) NOR `unwatermarked` (it HAS a
 * watermark): without this bucket it would silently fall into none and be
 * un-reconcilable — `sync` would report a false "synced" (phase-4.5-02).
 *
 * Mirrors the page-identity + watermark fields a `StaleEntry` carries; the
 * `symbol`/`symbolFile`/`symbolLine`/`current` fields are necessarily ABSENT —
 * the source symbol is gone from the graph (and a Page node stores no
 * `derived_from`, and this query reads no files), so there is no symbol to name
 * and no current fingerprint to report. That absence is exactly what distinguishes
 * orphaned (source GONE) from stale (source MOVED).
 */
export interface OrphanedEntry {
  page: string;        // the doc page (node name)
  pageFile: string;    // the page's file path
  syncedTo: string;    // the now-dangling watermark — the source it was last reconciled against
}

export interface DriftReport {
  stale: StaleEntry[];
  unwatermarked: UnwatermarkedEntry[];
  multiAnchor: MultiAnchorEntry[];
  uncomparable: UncomparableEntry[];
  orphaned: OrphanedEntry[];
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
  const orphaned: OrphanedEntry[] = [];
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

    if (targets.length === 0) {
      // No resolvable anchor target. A page that ALSO carries a `synced_to`
      // watermark was once reconciled against a source symbol that is now ABSENT
      // from the graph — RENAMED or DELETED (its node + DOCUMENTED_BY edge removed
      // by removeNodesByFile, or its anchor left unresolvable on re-index, or a
      // dangling edge whose target node is gone). The watermark is the surviving
      // proof of past provenance, so the page is neither `stale` (no live
      // fingerprint) nor `unwatermarked` (it HAS a watermark): surface it as
      // `orphaned` (dangling provenance) rather than silently dropping it
      // (phase-4.5-02). A page with NO watermark was simply never derived →
      // genuinely untracked, as before.
      if (node.syncedTo) {
        orphaned.push({ page: node.name, pageFile: node.file, syncedTo: node.syncedTo });
      }
      continue;
    }

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

  return { stale, unwatermarked, multiAnchor, uncomparable, orphaned, fresh };
}

/**
 * Neutralize an operator-controlled string field (page name, symbol, watermark —
 * sourced from wiki frontmatter) before it is interpolated into the markdown
 * report: a backtick would break out of the inline code span it sits in, and a
 * newline would split the one-line bullet — either distorts the rendered report
 * (SEC-LOW). Applied at RENDER only; the structured `drift` sidecar the kernel
 * consumes keeps the raw values (the entry objects are never mutated).
 */
function esc(value: string): string {
  return value
    .replace(/`/g, 'ˋ') // backtick → modifier grave accent: can't terminate a code span
    .replace(/\s*[\r\n]+\s*/g, ' '); // collapse newline(s) + surrounding whitespace to one space
}

/**
 * Render a drift report as the agent-facing markdown the recon_drift tool returns.
 * Names the page, the specific source symbol, and `synced_to` vs the current
 * fingerprint for every stale entry (sync-03 AC4).
 */
export function formatDrift(report: DriftReport): string {
  const { stale, unwatermarked, multiAnchor, uncomparable, orphaned, fresh } = report;

  const lines: string[] = [
    '# Drift Report',
    '',
    `**Stale:** ${stale.length} | **Unwatermarked:** ${unwatermarked.length} | ` +
      `**Multi-anchor:** ${multiAnchor.length} | **Uncomparable:** ${uncomparable.length} | ` +
      `**Orphaned:** ${orphaned.length} | **Fresh:** ${fresh}`,
    '',
  ];

  if (
    stale.length === 0 &&
    unwatermarked.length === 0 &&
    multiAnchor.length === 0 &&
    uncomparable.length === 0 &&
    orphaned.length === 0
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
        `- **${esc(s.symbol)}** drifted — \`${esc(s.page)}\` (\`${esc(s.pageFile)}\`) was synced to ` +
        `\`${esc(s.syncedTo)}\`, but \`${esc(s.symbolFile)}:${s.symbolLine}\` is now \`${esc(s.current)}\``,
      );
    }
    lines.push('');
  }

  if (unwatermarked.length > 0) {
    lines.push(`## Unwatermarked (${unwatermarked.length})`, '');
    for (const u of unwatermarked) {
      lines.push(
        `- **${esc(u.symbol)}** — \`${esc(u.page)}\` (\`${esc(u.pageFile)}\`) is derived_from ` +
        `\`${esc(u.symbolFile)}:${u.symbolLine}\` but carries no \`synced_to\` watermark`,
      );
    }
    lines.push('');
  }

  if (multiAnchor.length > 0) {
    lines.push(`## Multi-anchor — unsupported (${multiAnchor.length})`, '');
    for (const m of multiAnchor) {
      lines.push(
        `- \`${esc(m.page)}\` (\`${esc(m.pageFile)}\`) is derived_from ${m.symbols.length} symbols ` +
        `(${m.symbols.map((s) => `**${esc(s)}**`).join(', ')}) — multi-target drift is not compared`,
      );
    }
    lines.push('');
  }

  if (uncomparable.length > 0) {
    lines.push(`## Uncomparable (${uncomparable.length})`, '');
    for (const u of uncomparable) {
      lines.push(
        `- **${esc(u.symbol)}** — \`${esc(u.page)}\` (\`${esc(u.pageFile)}\`) is derived_from ` +
        `\`${esc(u.symbolFile)}:${u.symbolLine}\` (${esc(u.reason)})`,
      );
    }
    lines.push('');
  }

  if (orphaned.length > 0) {
    lines.push(`## Orphaned — dangling watermark (${orphaned.length})`, '');
    for (const o of orphaned) {
      lines.push(
        `- \`${esc(o.page)}\` (\`${esc(o.pageFile)}\`) is watermarked to \`${esc(o.syncedTo)}\` but its ` +
        `derived_from source symbol is gone from the graph (renamed/deleted) — provenance dangling`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

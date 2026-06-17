/**
 * Mandatory decay-weight measurement gate (harvest-09 / D3, AC2–AC4) — recon ADR 0005.
 *
 * Time-decay is SHIP-GATED: it enables (`full`) ONLY if a measurement on a gold
 * fixture proves the `recency × importance` re-ranking both (a) SINKS a known
 * stale page AND (b) HOLDS gold-query hit@5 vs the un-weighted baseline. If either
 * fails the gate selects `fallback` (importance-only, no time term) — recorded,
 * never a silent degrade (AC3). The chosen half-life is justified by a sweep
 * captured in the durable report (AC4).
 *
 * This is the PURE measurement layer (no I/O). It re-ranks a gold BASELINE ranking
 * with the SAME primitive production uses (decay-scorer.applyDecayRanking), so the
 * gate measures exactly the transform that ships. BM25 retrieval quality is gated
 * separately (find-bm25.test.ts). The gold fixture + the report-write live in the
 * test; this module computes the verdict and renders the report text.
 */

import { applyDecayRanking } from './decay-scorer.js';
import type { DecayMode, DecaySignals } from './decay-scorer.js';

/** One entry of a baseline ranking: an id (to resolve decay signals) + its file + score. */
export interface RankedItem {
  id: string;
  file: string;
  score: number;
}

/** Resolve an item id to its decay signals (null/undefined ⇒ no signal ⇒ neutral). */
export type SignalsResolver = (id: string) => DecaySignals | undefined;

export interface GateInput {
  /** Gold queries, each with its known-relevant file + the un-weighted baseline ranking. */
  goldQueries: Array<{ query: string; relevant: string; baseline: RankedItem[] }>;
  /** A probe whose baseline ranks a KNOWN-stale page high — decay must sink it. */
  staleProbe: { query: string; staleFile: string; baseline: RankedItem[] };
  getNode: SignalsResolver;
  /** Injected clock (epoch ms). */
  now: number;
  /** The half-life the verdict + shipped default are taken at. */
  halfLifeDays: number;
  /** Half-lives to sweep for the AC4 record. */
  sweepHalfLives: number[];
  /** Gold hit@5 must be ≥ baseline − tolerance to count as "held". */
  tolerance: number;
  /** hit@k cutoff. Defaults to 5. */
  k?: number;
}

export interface SweepRow {
  halfLifeDays: number;
  decayHit5: number;
  staleDecayRank: number;
  sank: boolean;
  held: boolean;
}

export interface GateResult {
  halfLifeDays: number;
  tolerance: number;
  k: number;
  baselineHit5: number;
  decayHit5: number;
  staleBaselineRank: number;
  staleDecayRank: number;
  staleSank: boolean;
  hitHeld: boolean;
  verdict: 'pass' | 'fail';
  mode: DecayMode;
  sweep: SweepRow[];
}

/** The ship gate (AC3): FULL only when the stale page sank AND gold hit@5 held. */
export function selectDecayMode(staleSank: boolean, hitHeld: boolean): DecayMode {
  return staleSank && hitHeld ? 'full' : 'fallback';
}

/** Fraction of queries whose relevant file lands in the top-k of its ranked files. */
function hitAtK(rankings: Array<{ relevant: string; rankedFiles: string[] }>, k: number): number {
  if (rankings.length === 0) return 0;
  let hits = 0;
  for (const { relevant, rankedFiles } of rankings) {
    if (rankedFiles.slice(0, k).includes(relevant)) hits++;
  }
  return hits / rankings.length;
}

/** Re-rank a baseline through FULL decay at a given half-life → ranked file list. */
function decayedFiles(
  baseline: RankedItem[],
  getNode: SignalsResolver,
  now: number,
  halfLifeDays: number,
): string[] {
  return applyDecayRanking(baseline, getNode, { now, halfLifeDays, mode: 'full' }).map((it) => it.file);
}

/** Measure one half-life: gold hit@5 (decayed) + the stale page's decayed rank. */
function measureAt(input: GateInput, halfLifeDays: number, k: number): { decayHit5: number; staleDecayRank: number } {
  const decayHit5 = hitAtK(
    input.goldQueries.map((q) => ({
      relevant: q.relevant,
      rankedFiles: decayedFiles(q.baseline, input.getNode, input.now, halfLifeDays),
    })),
    k,
  );
  const staleDecayRank = decayedFiles(
    input.staleProbe.baseline, input.getNode, input.now, halfLifeDays,
  ).indexOf(input.staleProbe.staleFile);
  return { decayHit5, staleDecayRank };
}

/**
 * Run the gate: compute baseline + FULL-decay gold hit@5, the stale page's rank
 * movement, the half-life sweep, the pass/fail verdict, and the selected mode.
 */
export function runGate(input: GateInput): GateResult {
  const k = input.k ?? 5;

  const baselineHit5 = hitAtK(
    input.goldQueries.map((q) => ({ relevant: q.relevant, rankedFiles: q.baseline.map((it) => it.file) })),
    k,
  );
  const staleBaselineRank = input.staleProbe.baseline.map((it) => it.file).indexOf(input.staleProbe.staleFile);

  const at = measureAt(input, input.halfLifeDays, k);
  const decayHit5 = at.decayHit5;
  const staleDecayRank = at.staleDecayRank;

  const staleSank = staleDecayRank > staleBaselineRank;
  const hitHeld = decayHit5 >= baselineHit5 - input.tolerance;
  const mode = selectDecayMode(staleSank, hitHeld);

  const sweep: SweepRow[] = input.sweepHalfLives.map((h) => {
    const m = measureAt(input, h, k);
    return {
      halfLifeDays: h,
      decayHit5: m.decayHit5,
      staleDecayRank: m.staleDecayRank,
      sank: m.staleDecayRank > staleBaselineRank,
      held: m.decayHit5 >= baselineHit5 - input.tolerance,
    };
  });

  return {
    halfLifeDays: input.halfLifeDays,
    tolerance: input.tolerance,
    k,
    baselineHit5,
    decayHit5,
    staleBaselineRank,
    staleDecayRank,
    staleSank,
    hitHeld,
    verdict: staleSank && hitHeld ? 'pass' : 'fail',
    mode,
    sweep,
  };
}

const f3 = (n: number): string => n.toFixed(3);
const yn = (b: boolean): string => (b ? 'yes' : 'no');

/**
 * Render the durable, deterministic gate report (AC2/AC4). Names the chosen
 * half-life + tolerance, the baseline-vs-decay metrics, the half-life sweep, the
 * verdict, the shipped mode, and the fallback contract. No clock / locale — stable
 * bytes so it is a committed, diff-able record (regenerate with `vitest -u`).
 */
export function renderGateReport(r: GateResult): string {
  const passed = r.verdict === 'pass';
  const lines: string[] = [
    '# Decay-Weight Measurement Gate — recon ADR 0005 (harvest-09 / D3)',
    '',
    '> Durable record of the MANDATORY gate (AC2-AC4). Generated by the decay-gate',
    '> harness (`test/unit/decay-gate.test.ts`) over the gold fixture and verified on',
    '> every run; regenerate with `vitest -u`. `SHIPPED_DECAY_MODE` in',
    '> `src/analyzers/decay-scorer.ts` is locked to this verdict.',
    '',
    `## Verdict: ${passed ? 'PASS' : 'FAIL'} → ship \`${r.mode}\`${passed ? ' (recency × importance)' : ' (importance-only, no time decay)'}`,
    '',
    `- Half-life: **${r.halfLifeDays} days** — cadence-justified (a page untouched for a`,
    '  month is cooling; ~3 half-lives ≈ 12.5%), and validated by the sweep below (AC4).',
    `- Tolerance: gold hit@${r.k} must be ≥ baseline − ${f3(r.tolerance)}.`,
    `- Gold hit@${r.k} — baseline: **${f3(r.baselineHit5)}** → decay: **${f3(r.decayHit5)}**  (held: ${yn(r.hitHeld)})`,
    `- Known-stale page rank — baseline: **#${r.staleBaselineRank}** → decay: **#${r.staleDecayRank}**  (sank: ${yn(r.staleSank)})`,
    `- Shipped mode: **${r.mode}**`,
    '',
    `## Half-life sweep (AC4 — measured, not guessed)`,
    '',
    `| half-life (days) | gold hit@${r.k} | stale rank | sinks | holds |`,
    '|---:|---:|---:|:--:|:--:|',
    ...r.sweep.map(
      (s) => `| ${s.halfLifeDays} | ${f3(s.decayHit5)} | #${s.staleDecayRank} | ${yn(s.sank)} | ${yn(s.held)} |`,
    ),
    '',
    '## Fallback contract (AC3)',
    '',
    'The gate is mandatory: time-decay ships ONLY when it both sinks the known-stale',
    'page AND holds gold hit@5. If either condition fails the harness selects',
    '`fallback` (importance-only, no time term) — the safe default — and records it',
    'here. The fallback is automatic; it is never a silent degrade.',
    '',
  ];
  return lines.join('\n');
}

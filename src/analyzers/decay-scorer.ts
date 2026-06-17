/**
 * Decay-weighted retrieval scorer (harvest-09 / D3) — recon ADR 0005.
 *
 * The SOTA payoff of Phase 5 (Generative Agents recency×importance×relevance):
 * a long-un-reinforced page SINKS in the ranking without being removed, while a
 * kept-fresh, high-importance page HOLDS. This module is the pure ranking
 * primitive — it reads the two per-page signals D1 (harvest-07) carries onto
 * prose Page nodes (`importance` + `lastReinforced`) and multiplies a
 * `recency × importance` factor into the RRF score at the ranking step
 * (executeFindHybrid). It NEVER deletes, NEVER writes frontmatter, and NEVER
 * reads the clock itself — the caller injects `now` so the scorer stays pure and
 * deterministic under test.
 *
 * Ship-gated (AC3): the time-decay ships ONLY because the mandatory measurement
 * gate passed (docs/eval/0005-decay-weight-gate.md) — `SHIPPED_DECAY_MODE`
 * records that verdict. If the gate ever fails it MUST flip to `'fallback'`
 * (importance-only, no time term), which the decay-gate test enforces. A node
 * with NO decay signal gets a NEUTRAL factor (exactly 1) so its rank is
 * unaffected — code symbols and signal-less prose are never disturbed.
 */

import { NEUTRAL_IMPORTANCE } from './prose-signals.js';
import type { Node } from '../graph/types.js';

/** Milliseconds per day — the recency term's age unit. */
const DAY_MS = 86_400_000;

/**
 * FULL = `recency × importance`; FALLBACK = importance-only (the time term is
 * dropped — the gate's safe default when time-decay can't be shown to help).
 */
export type DecayMode = 'full' | 'fallback';

/**
 * The recency half-life in DAYS: a page reinforced one half-life ago keeps half
 * its recency weight; two half-lives → a quarter; and so on. 30 days is chosen
 * to the wiki's reinforcement cadence — a page untouched for a month is cooling,
 * one untouched for a quarter (~3 half-lives) sits at ~12.5%. The decay gate
 * sweeps 7/14/30/60/90 and records that 30 both SINKS the known-stale set and
 * HOLDS gold hit@5 (docs/eval/0005-decay-weight-gate.md, AC4) — measured, not
 * guessed. Change it there and re-run the gate.
 */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * The SHIPPED decay mode — the recorded verdict of the mandatory gate (AC2/AC3).
 * `'full'` ⇒ the gate passed BOTH conditions (stale sinks AND gold hit@5 holds)
 * on the gold fixture, so `recency × importance` ships enabled. If the gate fails
 * this becomes `'fallback'` (importance-only) — never a silent degrade; the
 * decay-gate test locks this constant to `selectDecayMode(<gate verdict>)`.
 */
export const SHIPPED_DECAY_MODE: DecayMode = 'full';

export interface DecayOptions {
  /** Injected clock (epoch ms). The scorer never calls Date.now() itself. */
  now: number;
  /** Recency half-life in days. Defaults to DEFAULT_HALF_LIFE_DAYS. */
  halfLifeDays?: number;
  /** Scoring mode. Defaults to 'full' (recency × importance). */
  mode?: DecayMode;
}

/** The two decay signals D1 carries onto a prose Page node. */
export type DecaySignals = Pick<Node, 'importance' | 'lastReinforced'>;

/**
 * The `recency × importance` multiplier for one node, in `[0, ∞)` but centered
 * on 1:
 *   - NEITHER signal present → exactly `1` (neutral; rank unaffected, AC1).
 *   - importance term = `importance / NEUTRAL_IMPORTANCE` — centered so the
 *     neutral prior (0.5) maps to 1 (prose at the neutral prior competes evenly
 *     with no-signal code; a higher tier/importance boosts above 1, lower sinks
 *     below). importance is always set on prose by D1; it defaults to the neutral
 *     prior only as a guard.
 *   - recency term = `0.5 ^ (ageDays / halfLife)` ∈ `(0, 1]` — fresh (age ≤ 0) →
 *     1, one half-life → 0.5. Dropped (treated as 1) when `lastReinforced` is
 *     absent/unparseable, or in FALLBACK mode (importance-only).
 *
 * Pure + total: never throws, never reads the clock.
 */
export function decayFactor(node: DecaySignals, opts: DecayOptions): number {
  const hasImportance = typeof node.importance === 'number' && Number.isFinite(node.importance);
  const reinforcedAt = node.lastReinforced !== undefined ? Date.parse(node.lastReinforced) : NaN;
  const hasRecency = Number.isFinite(reinforcedAt);

  // AC1 neutral: a node with NEITHER signal is unaffected — exactly 1.
  if (!hasImportance && !hasRecency) return 1;

  const importance = hasImportance ? (node.importance as number) : NEUTRAL_IMPORTANCE;
  const importanceTerm = importance / NEUTRAL_IMPORTANCE;

  // FALLBACK: importance-only — the gate's safe default. No time term.
  if ((opts.mode ?? 'full') === 'fallback') return importanceTerm;

  // FULL: weight by the exponential-half-life recency term over last_reinforced.
  if (!hasRecency) return importanceTerm; // no time signal → neutral on the time axis
  const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (opts.now - reinforcedAt) / DAY_MS);
  const recencyTerm = Math.pow(0.5, ageDays / halfLife);
  return importanceTerm * recencyTerm;
}

/** The minimal shape applyDecayRanking ranks — an id to resolve signals + a score. */
export interface DecayRankable {
  id: string;
  score?: number;
}

/**
 * Multiply each item's score by its node's decay factor and re-rank descending.
 * `getNode` resolves an item's id to its decay signals (graph.getNode in the live
 * path); an unresolved id or a no-signal node yields the neutral factor 1, so a
 * set with NO decay signals returns in its ORIGINAL order (a stable sort over
 * unchanged scores) — the neutral-rank guarantee (AC1). Returns a new array;
 * every non-score field on each item is preserved.
 */
export function applyDecayRanking<T extends DecayRankable>(
  items: T[],
  getNode: (id: string) => DecaySignals | undefined,
  opts: DecayOptions,
): T[] {
  const scored = items.map((it): T => {
    const node = getNode(it.id);
    const factor = node ? decayFactor(node, opts) : 1;
    return { ...it, score: (it.score ?? 0) * factor };
  });
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored;
}

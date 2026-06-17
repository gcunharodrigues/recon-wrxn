/**
 * Unit Tests: mandatory decay-weight measurement gate (harvest-09 / D3, AC2–AC4)
 *
 * The gate that decides whether time-decay SHIPS. It measures, on a gold fixture,
 * that FULL decay (a) SINKS a known-stale page AND (b) HOLDS gold-query hit@5 vs
 * the un-weighted baseline. Passing BOTH ships `full`; failing either falls back
 * to importance-only (`fallback`) — recorded, never a silent degrade (AC3). The
 * shipped half-life is justified by a sweep recorded to the durable report (AC4).
 *
 * Adapts the find-bm25 gold-set / hit@k measurement pattern. The gate measures the
 * DECAY RE-RANKING TRANSFORM applied to a gold baseline ranking (BM25 retrieval
 * quality is separately gated in find-bm25.test.ts); the transform is identical to
 * production (executeFindHybrid → applyDecayRanking).
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  runGate,
  selectDecayMode,
  renderGateReport,
} from '../../src/analyzers/decay-gate.js';
import type { GateInput, RankedItem } from '../../src/analyzers/decay-gate.js';
import { SHIPPED_DECAY_MODE } from '../../src/analyzers/decay-scorer.js';
import type { DecaySignals } from '../../src/analyzers/decay-scorer.js';

const NOW = Date.parse('2026-06-17T00:00:00Z');
const FRESH = '2026-06-15'; // 2 days old
const STALE = '2026-01-01'; // ~167 days old
const SWEEP = [7, 14, 30, 60, 90];

function item(file: string, score: number): RankedItem {
  return { id: file, file, score };
}
function codeItem(name: string, score: number): RankedItem {
  return { id: `ts:func:${name}`, file: `src/${name}.ts`, score }; // no decay signal
}

// ─── selectDecayMode — the ship gate (AC3) ───────────────────────

describe('selectDecayMode — full only when BOTH conditions hold', () => {
  it('stale sinks AND hit@5 holds → full', () => {
    expect(selectDecayMode(true, true)).toBe('full');
  });
  it('stale sinks but hit@5 regresses → fallback', () => {
    expect(selectDecayMode(true, false)).toBe('fallback');
  });
  it('hit@5 holds but stale does NOT sink → fallback', () => {
    expect(selectDecayMode(false, true)).toBe('fallback');
  });
});

// ─── The PASS gold fixture ───────────────────────────────────────

const PASS_SIGNALS: Record<string, DecaySignals> = {
  'concepts/g1.md': { importance: 0.7, lastReinforced: FRESH },
  'decisions/g2.md': { importance: 0.8, lastReinforced: FRESH },
  'concepts/g3.md': { importance: 0.7, lastReinforced: FRESH },
  'gotchas/g4.md': { importance: 0.5, lastReinforced: FRESH },
  'concepts/fresh-auth.md': { importance: 0.8, lastReinforced: FRESH }, // fresh competitor
  'concepts/stale-auth.md': { importance: 0.3, lastReinforced: STALE }, // the known-stale page
};

const PASS: GateInput = {
  goldQueries: [
    { query: 'what enforces git push authority', relevant: 'concepts/g1.md',
      baseline: [item('concepts/g1.md', 0.030), codeItem('push', 0.020), item('archives/sprawl.md', 0.010)] },
    { query: 'why ship the doc-sync engine', relevant: 'decisions/g2.md',
      baseline: [item('decisions/g2.md', 0.030), codeItem('sync', 0.020)] },
    { query: 'how does the context engine inject rules', relevant: 'concepts/g3.md',
      baseline: [item('concepts/g3.md', 0.030), codeItem('inject', 0.018)] },
    { query: 'when is orphan analysis unreliable', relevant: 'gotchas/g4.md',
      baseline: [item('gotchas/g4.md', 0.030), codeItem('orphan', 0.020)] },
  ],
  staleProbe: {
    query: 'the auth flow',
    staleFile: 'concepts/stale-auth.md',
    // baseline ranks the STALE page #0 over a fresher competitor — decay must flip it.
    baseline: [item('concepts/stale-auth.md', 0.030), item('concepts/fresh-auth.md', 0.026), codeItem('auth', 0.010)],
  },
  getNode: (id) => PASS_SIGNALS[id],
  now: NOW,
  halfLifeDays: 30,
  sweepHalfLives: SWEEP,
  tolerance: 0,
};

describe('runGate — the PASS gold fixture ships FULL decay (AC2)', () => {
  const r = runGate(PASS);

  it('baseline gold hit@5 is 100% (the un-weighted reference)', () => {
    expect(r.baselineHit5).toBe(1);
  });
  it('FULL decay HOLDS gold hit@5 (no regression vs baseline)', () => {
    expect(r.decayHit5).toBeGreaterThanOrEqual(r.baselineHit5 - r.tolerance);
    expect(r.hitHeld).toBe(true);
  });
  it('FULL decay SINKS the known-stale page (its rank drops)', () => {
    expect(r.staleDecayRank).toBeGreaterThan(r.staleBaselineRank);
    expect(r.staleSank).toBe(true);
  });
  it('verdict PASS → shipped mode FULL', () => {
    expect(r.verdict).toBe('pass');
    expect(r.mode).toBe('full');
  });
  it('every swept half-life sinks the stale page AND holds hit@5 (AC4 — measured)', () => {
    expect(r.sweep.map((s) => s.halfLifeDays)).toEqual(SWEEP);
    for (const s of r.sweep) {
      expect(s.sank, `half-life ${s.halfLifeDays} must sink stale`).toBe(true);
      expect(s.held, `half-life ${s.halfLifeDays} must hold hit@5`).toBe(true);
    }
  });
});

// ─── The FORCED-REGRESSION fixture → automatic fallback (AC3) ─────

const REG_SIGNALS: Record<string, DecaySignals> = {
  'concepts/stale-gold.md': { importance: 0.3, lastReinforced: STALE }, // the gold answer is itself stale
  'concepts/d1.md': { importance: 0.8, lastReinforced: FRESH },
  'concepts/d2.md': { importance: 0.8, lastReinforced: FRESH },
  'concepts/d3.md': { importance: 0.8, lastReinforced: FRESH },
  'concepts/d4.md': { importance: 0.8, lastReinforced: FRESH },
  'concepts/d5.md': { importance: 0.8, lastReinforced: FRESH },
  'concepts/stale-auth.md': { importance: 0.3, lastReinforced: STALE },
  'concepts/fresh-auth.md': { importance: 0.8, lastReinforced: FRESH },
};

const REGRESSION: GateInput = {
  // The gold target is stale+low-importance with 5 fresher distractors above it on
  // raw score's heels — FULL decay sinks the RIGHT answer out of top-5: hit@5 drops.
  goldQueries: [
    { query: 'the deprecated-but-correct answer', relevant: 'concepts/stale-gold.md',
      baseline: [
        item('concepts/stale-gold.md', 0.030),
        item('concepts/d1.md', 0.029),
        item('concepts/d2.md', 0.028),
        item('concepts/d3.md', 0.027),
        item('concepts/d4.md', 0.026),
        item('concepts/d5.md', 0.025),
      ] },
  ],
  staleProbe: {
    query: 'the auth flow',
    staleFile: 'concepts/stale-auth.md',
    baseline: [item('concepts/stale-auth.md', 0.030), item('concepts/fresh-auth.md', 0.026), codeItem('auth', 0.010)],
  },
  getNode: (id) => REG_SIGNALS[id],
  now: NOW,
  halfLifeDays: 30,
  sweepHalfLives: SWEEP,
  tolerance: 0,
};

describe('runGate — a hit@5 regression triggers automatic FALLBACK (AC3)', () => {
  const r = runGate(REGRESSION);

  it('FULL decay HURTS gold hit@5 (the right answer sinks out of top-5)', () => {
    expect(r.decayHit5).toBeLessThan(r.baselineHit5);
    expect(r.hitHeld).toBe(false);
  });
  it('verdict FAIL → automatic fallback to importance-only', () => {
    expect(r.verdict).toBe('fail');
    expect(r.mode).toBe('fallback');
  });
});

// ─── SHIPPED_DECAY_MODE is locked to the gate verdict (AC3) ───────

describe('SHIPPED_DECAY_MODE is the recorded gate verdict (no silent drift)', () => {
  it('matches selectDecayMode of the live PASS-fixture gate', () => {
    const r = runGate(PASS);
    expect(SHIPPED_DECAY_MODE).toBe(selectDecayMode(r.staleSank, r.hitHeld));
    expect(SHIPPED_DECAY_MODE).toBe('full');
  });
});

// ─── The durable gate report (AC2/AC4) ───────────────────────────

describe('renderGateReport — durable, deterministic record', () => {
  it('matches the committed report at docs/eval/0005-decay-weight-gate.md', () => {
    const report = renderGateReport(runGate(PASS));
    const path = fileURLToPath(new URL('../../docs/eval/0005-decay-weight-gate.md', import.meta.url));
    expect(report).toMatchFileSnapshot(path);
  });
});

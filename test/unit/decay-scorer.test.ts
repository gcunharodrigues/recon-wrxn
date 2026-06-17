/**
 * Unit Tests: decay-weighted retrieval scorer (harvest-09 / D3)
 *
 * The pure ranking primitive behind recon ADR 0005. Two behaviors:
 *   - decayFactor: a recency×importance multiplier centered so a no-signal node
 *     is NEUTRAL (factor 1, rank unaffected); a stale low-importance page scores
 *     lower than a fresh high-importance one; the FALLBACK mode drops the time
 *     term (importance-only — the gate's safe default).
 *   - applyDecayRanking: multiplies the factor into each item's RRF score and
 *     re-ranks, leaving a no-signal set in its original order.
 *
 * Asserts external behavior only. The clock is INJECTED (opts.now) so the scorer
 * stays pure + deterministic — never Date.now() inside the factor.
 */
import { describe, it, expect } from 'vitest';
import {
  decayFactor,
  applyDecayRanking,
  SHIPPED_DECAY_MODE,
  DEFAULT_HALF_LIFE_DAYS,
} from '../../src/analyzers/decay-scorer.js';
import { NEUTRAL_IMPORTANCE } from '../../src/analyzers/prose-signals.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { executeFindHybrid } from '../../src/mcp/find.js';
import { BM25Index } from '../../src/search/bm25.js';
import { VectorStore } from '../../src/search/vector-store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-17T00:00:00Z');

// ─── decayFactor — the recency×importance multiplier ─────────────

describe('decayFactor — recency × importance, neutral when signals absent', () => {
  it('a node with NEITHER signal → neutral factor exactly 1 (rank unaffected)', () => {
    expect(decayFactor({}, { now: NOW })).toBe(1);
  });

  it('an unparseable last_reinforced is treated as no recency (importance-only term)', () => {
    // importance at the neutral prior → 1; a junk timestamp must not throw or skew.
    expect(decayFactor({ importance: NEUTRAL_IMPORTANCE, lastReinforced: 'not-a-date' }, { now: NOW }))
      .toBe(1);
  });

  it('neutral-importance + no recency → factor 1 (prose at the neutral prior competes evenly)', () => {
    expect(decayFactor({ importance: NEUTRAL_IMPORTANCE }, { now: NOW })).toBe(1);
  });

  it('importance is centered on NEUTRAL_IMPORTANCE: 1.0 → 2x boost, no recency', () => {
    expect(decayFactor({ importance: 1.0 }, { now: NOW })).toBeCloseTo(2.0, 6);
  });

  it('one half-life of age halves the recency term (importance neutral)', () => {
    // 2026-05-18 is exactly 30 days before 2026-06-17.
    const oneHalfLifeAgo = '2026-05-18';
    expect(
      decayFactor(
        { importance: NEUTRAL_IMPORTANCE, lastReinforced: oneHalfLifeAgo },
        { now: NOW, halfLifeDays: 30 },
      ),
    ).toBeCloseTo(0.5, 6);
  });

  it('a future last_reinforced clamps age to 0 → fresh (recency term 1)', () => {
    const future = new Date(NOW + 100 * DAY).toISOString();
    expect(decayFactor({ importance: NEUTRAL_IMPORTANCE, lastReinforced: future }, { now: NOW, halfLifeDays: 30 }))
      .toBeCloseTo(1.0, 6);
  });

  it('a stale low-importance page scores BELOW a fresh high-importance page (FULL mode)', () => {
    const stale = decayFactor(
      { importance: 0.3, lastReinforced: new Date(NOW - 180 * DAY).toISOString() },
      { now: NOW, halfLifeDays: 30 },
    );
    const fresh = decayFactor(
      { importance: 0.9, lastReinforced: new Date(NOW - 1 * DAY).toISOString() },
      { now: NOW, halfLifeDays: 30 },
    );
    expect(stale).toBeLessThan(fresh);
    expect(stale).toBeLessThan(1); // sank below neutral
    expect(fresh).toBeGreaterThan(1); // floated above neutral
  });

  it('FALLBACK mode drops the time term — importance-only, recency ignored', () => {
    const stale = new Date(NOW - 365 * DAY).toISOString();
    // Same importance, vastly different age → identical factor in fallback (no time).
    const aged = decayFactor({ importance: 0.9, lastReinforced: stale }, { now: NOW, mode: 'fallback' });
    const noAge = decayFactor({ importance: 0.9 }, { now: NOW, mode: 'fallback' });
    expect(aged).toBeCloseTo(noAge, 6);
    expect(aged).toBeCloseTo(0.9 / NEUTRAL_IMPORTANCE, 6); // pure importance term
  });

  it('FALLBACK still re-ranks by importance (higher importance → higher factor)', () => {
    const hi = decayFactor({ importance: 0.9 }, { now: NOW, mode: 'fallback' });
    const lo = decayFactor({ importance: 0.5 }, { now: NOW, mode: 'fallback' });
    expect(hi).toBeGreaterThan(lo);
  });
});

// ─── applyDecayRanking — multiply into the score + re-rank ────────

describe('applyDecayRanking — weights the score and re-ranks', () => {
  it('a no-signal set keeps its original order (neutral, rank unchanged)', () => {
    const items = [
      { id: 'a', score: 0.03 },
      { id: 'b', score: 0.02 },
      { id: 'c', score: 0.01 },
    ];
    const out = applyDecayRanking(items, () => undefined, { now: NOW });
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    // scores untouched when factor is 1
    expect(out.map((i) => i.score)).toEqual([0.03, 0.02, 0.01]);
  });

  it('FULL decay floats a fresh high-importance page over a higher-scored stale one; no-signal stays neutral', () => {
    // Baseline order S > F > C by raw score. S is stale+low-imp, F is fresh+high-imp,
    // C carries no signal. FULL decay must flip F above the raw #1 (S), sink S below
    // F, and leave C's score untouched (neutral).
    const items = [
      { id: 'S', score: 0.030 }, // stale, would-be #1 on raw score
      { id: 'F', score: 0.025 }, // fresh, raw #2
      { id: 'C', score: 0.005 }, // no signal, raw #3
    ];
    const nodes: Record<string, { importance?: number; lastReinforced?: string }> = {
      S: { importance: 0.3, lastReinforced: new Date(NOW - 200 * DAY).toISOString() },
      F: { importance: 0.9, lastReinforced: new Date(NOW - 1 * DAY).toISOString() },
    };
    const out = applyDecayRanking(items, (id) => nodes[id], { now: NOW, halfLifeDays: 30 });
    expect(out[0].id).toBe('F'); // fresh high-imp floated above the raw #1 (stale S)
    expect(out.findIndex((i) => i.id === 'F')).toBeLessThan(out.findIndex((i) => i.id === 'S')); // S sank
    expect(out.find((i) => i.id === 'C')!.score).toBe(0.005); // no-signal item: score untouched
  });

  it('preserves every non-score field on each item (only score + order change)', () => {
    const items = [{ id: 'x', score: 0.02, label: 'keep-me' }];
    const out = applyDecayRanking(items, () => undefined, { now: NOW });
    expect(out[0].label).toBe('keep-me');
  });
});

// ─── SHIPPED defaults ────────────────────────────────────────────

describe('shipped decay defaults', () => {
  it('SHIPPED_DECAY_MODE is the gate-recorded full mode', () => {
    expect(SHIPPED_DECAY_MODE).toBe('full');
  });
  it('DEFAULT_HALF_LIFE_DAYS is a positive, justified constant', () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toBeGreaterThan(0);
  });
});

// ─── executeFindHybrid wiring — decay re-ranks the fused result ───

describe('executeFindHybrid — applies decay to the fused RRF ranking (AC1 wiring)', () => {
  function page(id: string, name: string, file: string, sig?: Partial<Node>): Node {
    return {
      id, type: NodeType.Page, name, file,
      startLine: 1, endLine: 1, language: Language.Markdown, package: 'docs', exported: false,
      ...sig,
    };
  }
  function code(id: string, name: string, file: string): Node {
    return {
      id, type: NodeType.Function, name, file,
      startLine: 1, endLine: 5, language: Language.TypeScript, package: 'src', exported: true,
    };
  }
  function unitVec(dims: number, hot = 0): Float32Array {
    const v = new Float32Array(dims);
    v[hot] = 1;
    return v;
  }
  const fakeEmbed = (vec: Float32Array) => async (_q: string): Promise<Float32Array> => vec;

  // Both pages are equally strong lexical+vector matches for the query; the ONLY
  // difference is the decay signal. Extreme dates make the outcome independent of
  // the real wall clock the live path reads (Date.now() inside executeFindHybrid).
  const QUERY = 'shared concept retrieval term';
  function build(staleSignals: boolean) {
    const graph = new KnowledgeGraph();
    const stale = page('md:page:stale.md', 'Stale Page', 'docs/stale.md',
      staleSignals ? { importance: 0.3, lastReinforced: '2000-01-01' } : undefined);
    const fresh = page('md:page:fresh.md', 'Fresh Page', 'docs/fresh.md',
      staleSignals ? { importance: 0.9, lastReinforced: '2999-01-01' } : undefined);
    graph.addNode(stale);
    graph.addNode(fresh);
    graph.addNode(code('ts:func:noise', 'noise', 'src/noise.ts'));
    // Identical bodies → identical BM25; the stale page listed first so its raw rank ≥ fresh.
    const ranker = BM25Index.buildFromGraph(graph, {
      [stale.id]: 'shared concept retrieval term body alpha',
      [fresh.id]: 'shared concept retrieval term body alpha',
    });
    const store = new VectorStore(3);
    store.add(stale.id, unitVec(3, 0), NodeType.Page);
    store.add(fresh.id, unitVec(3, 0), NodeType.Page);
    return { graph, ranker, store };
  }

  it('with decay signals, the fresh high-importance page outranks the stale low-importance one', async () => {
    const { graph, ranker, store } = build(true);
    const files = (
      await executeFindHybrid(graph, QUERY, { limit: 5 }, store, fakeEmbed(unitVec(3, 0)), ranker)
    ).map((r) => r.file);
    expect(files).toContain('docs/fresh.md');
    expect(files).toContain('docs/stale.md');
    expect(files.indexOf('docs/fresh.md')).toBeLessThan(files.indexOf('docs/stale.md'));
  });

  it('without signals the two pages keep their baseline (neutral) relative order', async () => {
    const { graph, ranker, store } = build(false);
    const files = (
      await executeFindHybrid(graph, QUERY, { limit: 5 }, store, fakeEmbed(unitVec(3, 0)), ranker)
    ).map((r) => r.file);
    // No decay signal on either page → factor 1 → the fresh page is NOT floated above stale.
    expect(files.indexOf('docs/stale.md')).toBeLessThan(files.indexOf('docs/fresh.md'));
  });
});

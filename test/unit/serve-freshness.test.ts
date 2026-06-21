/**
 * Unit Tests: serveFreshness — the serve footer reads the LIVE dirty set ([#11] D2)
 *
 * In serve, the per-answer watermark is NOT a fresh git count (that is the cold CLI path,
 * computeFreshness). It is the commit + comparability fixed once at startup (the `baseline`)
 * combined with the watcher-maintained live set's CURRENT size — so the footer reflects the
 * live served graph (near-zero when the watcher keeps up), not the persisted index, with no
 * git shell-out per answer. The non-git / uncomparable degradation is preserved: when the
 * baseline is already `unknown`, serve keeps reporting `unknown` exactly as the cold path would.
 */
import { describe, it, expect } from 'vitest';
import { serveFreshness } from '../../src/mcp/freshness.js';
import type { Freshness } from '../../src/mcp/freshness.js';

describe('[#11] serveFreshness — footer reads the live dirty set, not the seed/persisted count', () => {
  it('reports the LIVE set size for a comparable repo (not the seed/persisted view)', () => {
    // baseline.dirty is the seed-time view; the live set is what the watcher now holds.
    const baseline: Freshness = { commit: 'abc1234', dirty: 7 };
    const live = new Set(['src/a.ts']); // watcher has absorbed all but one file
    expect(serveFreshness(baseline, live)).toEqual({ commit: 'abc1234', dirty: 1 });
  });

  it('a drained live set yields a near-zero count even if the seed was large', () => {
    const baseline: Freshness = { commit: 'abc1234', dirty: 42 };
    expect(serveFreshness(baseline, new Set())).toEqual({ commit: 'abc1234', dirty: 0 });
  });

  it('degrades to the unknown watermark in serve exactly when the cold path would (non-git)', () => {
    const baseline: Freshness = { commit: 'none', dirty: 'unknown' };
    expect(serveFreshness(baseline, new Set(['x']))).toEqual({ commit: 'none', dirty: 'unknown' });
  });
});

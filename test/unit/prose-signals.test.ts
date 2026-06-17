/**
 * Unit Tests: prose decay signals (harvest-07 / D1)
 *
 * The PURE core of importance + reinforce-recency ingest:
 *   - tier-prior defaults for `importance:` (a small fixed map over the 4 wiki tiers)
 *   - the PINNED reinforce.json join key = the page's wiki-root-relative path
 *   - a fail-open `.wrxn/reinforce.json` reader (absent/malformed → {})
 *   - applyRecency: carry `last_reinforced` onto Page nodes joined by that key
 *
 * Asserts external behavior only. Pure ingest — no ranking here (harvest-09).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TIER_PRIORS,
  NEUTRAL_IMPORTANCE,
  tierPriorFor,
  wikiRelativePath,
  clampImportance,
  loadReinforceSidecar,
  applyRecency,
} from '../../src/analyzers/prose-signals.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';

// ─── Fixtures ────────────────────────────────────────────────────

function page(file: string, overrides?: Partial<Node>): Node {
  return {
    id: `md:page:${file}`,
    type: NodeType.Page,
    name: file.split('/').pop()!,
    file,
    startLine: 1,
    endLine: 1,
    language: Language.Markdown,
    package: '',
    exported: false,
    ...overrides,
  };
}

// ─── wikiRelativePath: the PINNED reinforce.json join key ─────────

describe('wikiRelativePath — the pinned reinforce.json join key', () => {
  it('strips the .wrxn/wiki/ prefix to a wiki-root-relative path', () => {
    expect(wikiRelativePath('.wrxn/wiki/concepts/foo.md')).toBe('concepts/foo.md');
    expect(wikiRelativePath('.wrxn/wiki/_rules/no-x.md')).toBe('_rules/no-x.md');
  });

  it('tolerates a leading ./ and backslash separators', () => {
    expect(wikiRelativePath('./.wrxn/wiki/decisions/d.md')).toBe('decisions/d.md');
    expect(wikiRelativePath('.wrxn\\wiki\\gotchas\\g.md')).toBe('gotchas/g.md');
  });

  it('returns null for a path outside the wiki (ordinary docs / README)', () => {
    expect(wikiRelativePath('docs/guide.md')).toBeNull();
    expect(wikiRelativePath('README.md')).toBeNull();
    expect(wikiRelativePath('.wrxn/wiki/')).toBeNull();
  });
});

// ─── tier priors (the default when `importance:` is absent) ───────

describe('tierPriorFor — default importance per wiki tier', () => {
  it('returns each tier prior for a page under that tier', () => {
    expect(tierPriorFor('.wrxn/wiki/_rules/x.md')).toBe(TIER_PRIORS._rules);
    expect(tierPriorFor('.wrxn/wiki/decisions/x.md')).toBe(TIER_PRIORS.decisions);
    expect(tierPriorFor('.wrxn/wiki/concepts/x.md')).toBe(TIER_PRIORS.concepts);
    expect(tierPriorFor('.wrxn/wiki/gotchas/x.md')).toBe(TIER_PRIORS.gotchas);
  });

  it('falls back to NEUTRAL_IMPORTANCE for non-wiki / unknown-tier prose', () => {
    expect(tierPriorFor('docs/guide.md')).toBe(NEUTRAL_IMPORTANCE);
    expect(tierPriorFor('.wrxn/wiki/sessions/s.md')).toBe(NEUTRAL_IMPORTANCE);
  });

  it('every prior (and the neutral default) is a valid 0–1 importance', () => {
    for (const v of [...Object.values(TIER_PRIORS), NEUTRAL_IMPORTANCE]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ─── clampImportance: validate a 0–1 scalar ──────────────────────

describe('clampImportance — accept valid 0–1, reject the rest', () => {
  it('accepts an in-range float', () => {
    expect(clampImportance('0.8')).toBe(0.8);
    expect(clampImportance('0')).toBe(0);
    expect(clampImportance('1')).toBe(1);
  });

  it('rejects a non-number → undefined (caller uses the tier prior)', () => {
    expect(clampImportance('high')).toBeUndefined();
    expect(clampImportance('')).toBeUndefined();
    expect(clampImportance(undefined)).toBeUndefined();
  });

  it('rejects an out-of-range number → undefined', () => {
    expect(clampImportance('1.5')).toBeUndefined();
    expect(clampImportance('-0.2')).toBeUndefined();
  });
});

// ─── loadReinforceSidecar: fail-open .wrxn/reinforce.json read ────

describe('loadReinforceSidecar — fail-open recency sidecar read', () => {
  it('reads a wiki-root-relative-path → timestamp map', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-reinforce-'));
    try {
      mkdirSync(join(root, '.wrxn'), { recursive: true });
      writeFileSync(
        join(root, '.wrxn', 'reinforce.json'),
        JSON.stringify({ 'concepts/foo.md': '2026-06-17', 'gotchas/g.md': '2026-06-10' }),
      );
      expect(loadReinforceSidecar(root)).toEqual({
        'concepts/foo.md': '2026-06-17',
        'gotchas/g.md': '2026-06-10',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns {} when the sidecar is absent (graceful, no throw)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-reinforce-'));
    try {
      expect(loadReinforceSidecar(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns {} when the sidecar is malformed JSON (ignored, no throw)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-reinforce-'));
    try {
      mkdirSync(join(root, '.wrxn'), { recursive: true });
      writeFileSync(join(root, '.wrxn', 'reinforce.json'), '{ not valid json');
      expect(loadReinforceSidecar(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores an over-cap sidecar gracefully (memory-DoS guard — {}, no throw)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-reinforce-'));
    try {
      mkdirSync(join(root, '.wrxn'), { recursive: true });
      // Valid JSON whose byte size exceeds the cap — trailing whitespace is legal
      // JSON, so an UNCAPPED reader would parse + return the entry. The cap must
      // skip the read entirely (stat-and-cap) and fall back to {}.
      const oversize =
        JSON.stringify({ 'concepts/foo.md': '2026-06-17' }) + ' '.repeat(9 * 1024 * 1024);
      writeFileSync(join(root, '.wrxn', 'reinforce.json'), oversize);
      expect(loadReinforceSidecar(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── applyRecency: carry last_reinforced onto matching Page nodes ──

describe('applyRecency — join recency onto Page nodes by wiki-root-relative path', () => {
  it('sets lastReinforced on a Page whose wiki-rel path is in the sidecar', () => {
    const nodes = [page('.wrxn/wiki/concepts/foo.md')];
    applyRecency(nodes, { 'concepts/foo.md': '2026-06-17' });
    expect(nodes[0].lastReinforced).toBe('2026-06-17');
  });

  it('leaves a Page with no sidecar entry untouched (no recency)', () => {
    const nodes = [page('.wrxn/wiki/concepts/foo.md')];
    applyRecency(nodes, { 'concepts/other.md': '2026-06-17' });
    expect('lastReinforced' in nodes[0]).toBe(false);
  });

  it('a slug-vs-path key mismatch is a silent no-op (the pinned seam)', () => {
    // harvest-08 MUST key by wiki-root-relative path. A wrong key (e.g. a bare
    // slug, or the full project path) joins to nothing → no recency, no throw.
    const nodes = [page('.wrxn/wiki/concepts/foo.md')];
    applyRecency(nodes, { foo: '2026-06-17', '.wrxn/wiki/concepts/foo.md': '2026-06-17' });
    expect('lastReinforced' in nodes[0]).toBe(false);
  });

  it('never stamps recency on a non-Page node (Section/code)', () => {
    const section: Node = {
      ...page('.wrxn/wiki/concepts/foo.md'),
      id: 'md:section:.wrxn/wiki/concepts/foo.md#h@1',
      type: NodeType.Section,
    };
    applyRecency([section], { 'concepts/foo.md': '2026-06-17' });
    expect('lastReinforced' in section).toBe(false);
  });

  it('an empty sidecar is a no-op over all nodes', () => {
    const nodes = [page('.wrxn/wiki/concepts/foo.md'), page('docs/guide.md')];
    applyRecency(nodes, {});
    expect(nodes.every((n) => !('lastReinforced' in n))).toBe(true);
  });
});

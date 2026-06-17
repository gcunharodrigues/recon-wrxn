/**
 * Unit Tests: recon_drift — the computable stale set (sync-03)
 *
 * computeDrift is a PURE indexed-graph compare (AC3): for each prose Page that
 * carries a `derived_from` anchor (a DOCUMENTED_BY edge to a code symbol) AND a
 * `synced_to` watermark (sync-01), it is STALE iff the target symbol's current
 * `fingerprint` (sync-02) differs from the watermark — fingerprint-vs-fingerprint.
 * No git, no fs, no `recon_changes` shell-out: only the indexed graph is read.
 *
 * The fixtures build DOCUMENTED_BY edges at the real anchor confidence
 * (ANCHOR_CONFIDENCE) the edge resolver stamps, so the anchor-vs-citation
 * discriminator drift relies on stays honest against doc-edges.ts.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { ANCHOR_CONFIDENCE, CITATION_CONFIDENCE } from '../../src/analyzers/doc-edges.js';
import { computeDrift, formatDrift } from '../../src/mcp/drift.js';

// ─── Fixtures ───────────────────────────────────────────────────

function symbol(id: string, name: string, overrides?: Partial<Node>): Node {
  return {
    id,
    type: NodeType.Function,
    name,
    file: 'src/auth.ts',
    startLine: 10,
    endLine: 20,
    language: Language.TypeScript,
    package: 'src',
    exported: true,
    ...overrides,
  };
}

function page(id: string, name: string, overrides?: Partial<Node>): Node {
  return {
    id,
    type: NodeType.Page,
    name,
    file: 'docs/auth.md',
    startLine: 1,
    endLine: 40,
    language: Language.Markdown,
    package: 'docs',
    exported: false,
    ...overrides,
  };
}

/** A DOCUMENTED_BY edge (Page → code symbol) at a given provenance confidence. */
function docEdge(pageId: string, symbolId: string, confidence: number): Relationship {
  return {
    id: `${pageId}-DOCUMENTED_BY-${symbolId}`,
    type: RelationshipType.DOCUMENTED_BY,
    sourceId: pageId,
    targetId: symbolId,
    confidence,
  };
}

// ─── AC2: stale-vs-fresh, fingerprint-vs-fingerprint ────────────

describe('computeDrift — AC2 stale iff fingerprint(source_now) !== synced_to', () => {
  it('reports a watermarked page STALE when the source fingerprint moved', () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'bbbbbbbbbbbbbbbb' }));
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0].symbol).toBe('login');
    expect(report.stale[0].syncedTo).toBe('bbbbbbbbbbbbbbbb');
    expect(report.stale[0].current).toBe('aaaaaaaaaaaaaaaa');
    expect(report.unwatermarked).toHaveLength(0);
  });

  it('a FRESH page (synced_to == current fingerprint) is ABSENT from stale (AC5)', () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'dddddddddddddddd' }));
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'dddddddddddddddd' }));
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(0);
    expect(report.unwatermarked).toHaveLength(0);
    expect(report.fresh).toBe(1);
  });
});

// ─── AC4 (R2 finding): the SPECIFIC target symbol, not a class umbrella ──

describe('computeDrift — AC4 names the specific target symbol the anchor resolves to', () => {
  it('compares the documented METHOD fingerprint, never its enclosing class', () => {
    const g = new KnowledgeGraph();
    // A class whose fingerprint subsumes its methods' subtrees…
    g.addNode(symbol('ts:class:UserService', 'UserService', {
      type: NodeType.Class,
      startLine: 1,
      endLine: 60,
      fingerprint: 'cccccccccccccccc',
    }));
    // …and the specific method the page is derived_from.
    g.addNode(symbol('ts:method:UserService.login', 'login', {
      type: NodeType.Method,
      startLine: 12,
      endLine: 18,
      fingerprint: 'aaaaaaaaaaaaaaaa',
    }));
    g.addRelationship({
      id: 'ts:class:UserService-HAS_METHOD-ts:method:UserService.login',
      type: RelationshipType.HAS_METHOD,
      sourceId: 'ts:class:UserService',
      targetId: 'ts:method:UserService.login',
      confidence: 1.0,
    });
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'bbbbbbbbbbbbbbbb' }));
    // The anchor `src/auth.ts#login` resolves to the METHOD node, so the edge targets it.
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:method:UserService.login', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(1);
    // The exact symbol the anchor named — NOT the class.
    expect(report.stale[0].symbol).toBe('login');
    expect(report.stale[0].current).toBe('aaaaaaaaaaaaaaaa'); // method fp
    expect(report.stale[0].current).not.toBe('cccccccccccccccc'); // never the class fp
    expect(report.stale[0].symbolLine).toBe(12);
  });
});

// ─── AC5: unwatermarked bucket (derived_from but no synced_to) ──

describe('computeDrift — AC5 unwatermarked bucket', () => {
  it('a page with a derived_from anchor but NO synced_to is unwatermarked, not stale', () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide')); // no syncedTo
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(0);
    expect(report.unwatermarked).toHaveLength(1);
    expect(report.unwatermarked[0].page).toBe('Auth Guide');
    expect(report.unwatermarked[0].symbol).toBe('login');
  });

  it('a page with NO derived_from anchor at all is tracked in neither bucket', () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
    g.addNode(page('md:page:docs/plain.md', 'Plain Guide', { syncedTo: 'zzzzzzzzzzzzzzzz' }));
    // no DOCUMENTED_BY edge

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(0);
    expect(report.unwatermarked).toHaveLength(0);
  });
});

// ─── AC2/AC5: only derived_from ANCHOR edges count, never file:line citations ──

describe('computeDrift — incidental file:line citations are not provenance', () => {
  it('a citation-only DOCUMENTED_BY edge does NOT make a watermarked page stale', () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:helper', 'helper', { fingerprint: 'eeeeeeeeeeeeeeee' }));
    g.addNode(page('md:page:docs/note.md', 'Note', { syncedTo: 'ffffffffffffffff' }));
    // A weak `file:line` body citation — NOT a derived_from anchor.
    g.addRelationship(docEdge('md:page:docs/note.md', 'ts:func:helper', CITATION_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(0);
    expect(report.unwatermarked).toHaveLength(0);
  });
});

// ─── AC4: formatted report names page, symbol, watermark vs current ──

describe('formatDrift — renders the AC4 fields', () => {
  it('names the page, the symbol, and synced_to vs current fingerprint', () => {
    const report = computeDrift((() => {
      const g = new KnowledgeGraph();
      g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
      g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'bbbbbbbbbbbbbbbb' }));
      g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));
      return g;
    })());

    const out = formatDrift(report);
    expect(out).toContain('Auth Guide');
    expect(out).toContain('login');
    expect(out).toContain('bbbbbbbbbbbbbbbb'); // synced_to
    expect(out).toContain('aaaaaaaaaaaaaaaa'); // current fingerprint
  });

  it('a clean corpus (nothing stale, nothing unwatermarked) renders a no-drift line', () => {
    const out = formatDrift({ stale: [], unwatermarked: [], multiAnchor: [], uncomparable: [], fresh: 0 });
    expect(out.toLowerCase()).toContain('no drift');
  });
});

// ─── HIGH (review-fix): multi-anchor pages route to a distinct bucket ────

// A page whose `derived_from` resolves to MORE THAN ONE source symbol cannot be
// drift-checked against its single `synced_to` watermark — comparing each target
// to the one watermark falsely marks all-but-one STALE (and pollutes fresh). Such
// a page lands in a distinct `multiAnchor` bucket, never stale/fresh/unwatermarked.
describe('computeDrift — a multi-anchor page is bucketed, never mis-compared', () => {
  it('a watermarked 2-anchor page lands in multiAnchor, not stale/fresh', () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
    g.addNode(symbol('ts:func:logout', 'logout', { startLine: 30, endLine: 40, fingerprint: 'bbbbbbbbbbbbbbbb' }));
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'aaaaaaaaaaaaaaaa' }));
    // Two `derived_from` anchor targets on the one page.
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:logout', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.multiAnchor).toHaveLength(1);
    expect(report.multiAnchor[0].page).toBe('Auth Guide');
    expect(report.multiAnchor[0].symbols).toEqual(expect.arrayContaining(['login', 'logout']));
    // The watermark-matching target must NOT leak into fresh, nor the other into stale.
    expect(report.stale).toHaveLength(0);
    expect(report.fresh).toBe(0);
  });
});

// ─── MED (review-fix): a watermarked fingerprint-less target is uncomparable ──

// A watermarked page whose anchor resolves to a File node or a raw Source artifact
// (no symbol `fingerprint`) was silently dropped from every bucket. It now lands in
// a distinct `uncomparable` bucket (sync-03 AC5: a watermarked page is never dropped).
describe('computeDrift — a watermarked whole-file/Source target is uncomparable', () => {
  it('a watermarked page anchored to a File node lands in uncomparable, not dropped', () => {
    const g = new KnowledgeGraph();
    // A bare-path anchor resolves to a File node — no fingerprint to compare.
    g.addNode(symbol('ts:file:src/auth.ts', 'auth.ts', { type: NodeType.File }));
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'bbbbbbbbbbbbbbbb' }));
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:file:src/auth.ts', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.uncomparable).toHaveLength(1);
    expect(report.uncomparable[0].page).toBe('Auth Guide');
    expect(report.uncomparable[0].symbol).toBe('auth.ts');
    expect(report.stale).toHaveLength(0);
    expect(report.fresh).toBe(0);
  });
});

// ─── LOW (review-fix): an empty-string watermark is unwatermarked, not stale ──

describe('computeDrift — an empty-string watermark is treated as unwatermarked', () => {
  it("a page with synced_to '' is unwatermarked, never compared to a fingerprint", () => {
    const g = new KnowledgeGraph();
    g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
    g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: '' }));
    g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));

    const report = computeDrift(g);

    expect(report.stale).toHaveLength(0);
    expect(report.unwatermarked).toHaveLength(1);
    expect(report.unwatermarked[0].symbol).toBe('login');
  });
});

// ─── formatDrift renders the new buckets ─────────────────────────

describe('formatDrift — renders the multiAnchor and uncomparable buckets', () => {
  it('lists a multi-anchor page and an uncomparable page in the output', () => {
    const out = formatDrift({
      stale: [],
      unwatermarked: [],
      multiAnchor: [
        { page: 'Multi Guide', pageFile: 'docs/multi.md', symbols: ['login', 'logout'], syncedTo: 'aaaa' },
      ],
      uncomparable: [
        {
          page: 'Whole Guide',
          pageFile: 'docs/whole.md',
          symbol: 'auth.ts',
          symbolFile: 'src/auth.ts',
          symbolLine: 1,
          reason: 'no fingerprint / whole-file target',
        },
      ],
      fresh: 0,
    });
    expect(out).toContain('Multi Guide');
    expect(out).toContain('login');
    expect(out).toContain('Whole Guide');
    expect(out).toContain('auth.ts');
  });
});

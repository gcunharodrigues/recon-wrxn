/**
 * Unit Tests: evidence-frontmatter edge resolver (citation-recon R2, #19)
 *
 * resolveEvidenceEdges turns the kernel's FROZEN evidence-frontmatter contract
 * (wrxn-kernel #33) — `evidence:{ session, commit, symbols }` harvested per page
 * by analyzeMarkdown — into citation edges against the live graph, mirroring
 * resolveDocEdges (runs after code + prose + SessionEvent nodes are in the graph):
 *   • EVIDENCED_BY  — page → each SessionEvent of `evidence.session` (R1 carries
 *                     the sid as node.package); the `evidence.commit` sha rides as
 *                     a metadata watermark, tagged resolved iff it is a valid sha.
 *   • DOCUMENTED_BY — page → the code node each `evidence.symbols` entry resolves
 *                     to, REUSING resolveDocEdges' precision-first resolution.
 * Every emitted edge carries a deterministic index-time `metadata.tag`
 * ('resolved' = target provably exists). Fail-soft + idempotent: unresolvable
 * evidence → no edge, never a throw; re-running yields identical edges.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import type { EvidenceSignal } from '../../src/analyzers/markdown.js';
import { analyzeMarkdown } from '../../src/analyzers/markdown.js';
import { resolveEvidenceEdges } from '../../src/analyzers/evidence-edges.js';

// ─── A small graph: code + a page + session events ──────────────

function codeNode(id: string, name: string, o: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name,
    file: 'src/x.ts', startLine: 1, endLine: 10,
    language: Language.TypeScript, package: 'src', exported: true,
    ...o,
  };
}

const PAGE_ID = 'md:page:.wrxn/wiki/concepts/auth.md';

/** A SessionEvent as R1 emits it: id event:<file>:<line>, package === sid. */
function sessionEvent(file: string, line: number, sid: string): Node {
  return {
    id: `event:${file}:${line}`, type: NodeType.SessionEvent,
    name: `prompt @ t${line}`, file: `.wrxn/events/${file}.jsonl`,
    startLine: line + 1, endLine: line + 1, language: Language.Json,
    package: sid, exported: false, eventKind: 'prompt',
  };
}

function buildGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  // the page that declares the evidence block
  g.addNode(codeNode(PAGE_ID, 'Auth', {
    type: NodeType.Page, file: '.wrxn/wiki/concepts/auth.md',
    language: Language.Markdown, package: '.wrxn/wiki/concepts', exported: false,
  }));
  // code: a File node + an exported symbol (DOCUMENTED_BY targets)
  g.addNode(codeNode('ts:file:src/auth/login.ts', 'login.ts', {
    type: NodeType.File, file: 'src/auth/login.ts', startLine: 0, endLine: 0, package: 'src/auth',
  }));
  g.addNode(codeNode('ts:func:login', 'login', {
    file: 'src/auth/login.ts', startLine: 5, endLine: 20, package: 'src/auth',
  }));
  // two events of session 'sess-1' + one of a different session
  g.addNode(sessionEvent('sess-1', 0, 'sess-1'));
  g.addNode(sessionEvent('sess-1', 1, 'sess-1'));
  g.addNode(sessionEvent('other', 0, 'sess-other'));
  return g;
}

const sig = (o: Partial<EvidenceSignal>): EvidenceSignal =>
  ({ sourceId: PAGE_ID, symbols: [], ...o });

// ─── EVIDENCED_BY: page → the cited session's events ─────────────

describe('resolveEvidenceEdges — evidence.session → EVIDENCED_BY', () => {
  it('links the page to every SessionEvent of the cited session, tagged resolved', () => {
    const edges = resolveEvidenceEdges(buildGraph(), [sig({ session: 'sess-1' })]);
    const ev = edges.filter((e) => e.type === RelationshipType.EVIDENCED_BY);
    expect(ev.map((e) => e.targetId).sort()).toEqual([
      'event:sess-1:0', 'event:sess-1:1',
    ]);
    for (const e of ev) {
      expect(e.sourceId).toBe(PAGE_ID);
      expect(e.metadata?.tag).toBe('resolved');
    }
    // never links the page to a different session's events
    expect(ev.some((e) => e.targetId === 'event:other:0')).toBe(false);
  });
});

// ─── DOCUMENTED_BY: evidence.symbols → code nodes (reuse doc-edges) ───

describe('resolveEvidenceEdges — evidence.symbols → DOCUMENTED_BY', () => {
  it('a symbol resolving to a real code node yields a resolved DOCUMENTED_BY edge (page → symbol)', () => {
    const edges = resolveEvidenceEdges(buildGraph(), [
      sig({ symbols: ['src/auth/login.ts#login', 'src/auth/login.ts'] }),
    ]);
    const doc = edges.filter((e) => e.type === RelationshipType.DOCUMENTED_BY);
    expect(doc.map((e) => e.targetId).sort()).toEqual([
      'ts:file:src/auth/login.ts', // bare path → File node (doc-edges resolution)
      'ts:func:login',             // path#symbol → the symbol
    ]);
    for (const e of doc) {
      expect(e.sourceId).toBe(PAGE_ID);
      expect(e.metadata?.tag).toBe('resolved');
    }
  });

  it('an unresolvable symbol (bare name / unknown path) yields NO edge (precision-first, no fuzzy)', () => {
    const edges = resolveEvidenceEdges(buildGraph(), [
      sig({ symbols: ['login', 'src/nope/missing.ts', 'src/auth/login.ts#ghost'] }),
    ]);
    expect(edges).toHaveLength(0);
  });
});

// ─── evidence.commit: a sha watermark on the EVIDENCED_BY edge ────

describe('resolveEvidenceEdges — evidence.commit watermark', () => {
  it('a valid sha rides on every EVIDENCED_BY edge, tagged commitResolved', () => {
    const edges = resolveEvidenceEdges(buildGraph(), [
      sig({ session: 'sess-1', commit: '5615acb' }),
    ]);
    const ev = edges.filter((e) => e.type === RelationshipType.EVIDENCED_BY);
    expect(ev).toHaveLength(2);
    for (const e of ev) {
      expect(e.metadata?.commit).toBe('5615acb');
      expect(e.metadata?.commitResolved).toBe(true);
    }
  });

  it('a malformed commit is still carried but tagged inferred (commitResolved false)', () => {
    const [e] = resolveEvidenceEdges(buildGraph(), [
      sig({ session: 'sess-1', commit: 'not-a-sha!' }),
    ]).filter((x) => x.type === RelationshipType.EVIDENCED_BY);
    expect(e.metadata?.commit).toBe('not-a-sha!');
    expect(e.metadata?.commitResolved).toBe(false);
  });

  it('no commit declared → no commit watermark on the edge', () => {
    const [e] = resolveEvidenceEdges(buildGraph(), [sig({ session: 'sess-1' })]);
    expect(e.metadata?.commit).toBeUndefined();
    expect(e.metadata?.commitResolved).toBeUndefined();
  });
});

// ─── FOLD (R3, #20): commitResolved reflects REAL git history, not just sha shape ──
//
// R2 set commitResolved on SYNTACTIC sha shape alone, which OVERCLAIMS `resolved`
// for a well-formed-but-nonexistent sha. The resolver now accepts an INJECTED
// commitExists(sha) checker (the index call site has git): a sha is resolved only
// when it is both well-formed AND actually present in history. With no checker (or
// outside a repo) it falls back to syntactic validity — fail-soft, no IO dependency.
describe('resolveEvidenceEdges — commitResolved reflects real git history (injected checker)', () => {
  it('a well-formed sha that EXISTS in history → commitResolved true', () => {
    const [e] = resolveEvidenceEdges(buildGraph(),
      [sig({ session: 'sess-1', commit: '5615acb' })], (sha) => sha === '5615acb');
    expect(e.metadata?.commitResolved).toBe(true);
  });

  it('a well-formed sha that does NOT exist → commitResolved false (no longer overclaims resolved)', () => {
    const [e] = resolveEvidenceEdges(buildGraph(),
      [sig({ session: 'sess-1', commit: 'abcdef0' })], () => false);
    expect(e.metadata?.commit).toBe('abcdef0');   // still carried — fail-soft, stays visible
    expect(e.metadata?.commitResolved).toBe(false);
  });

  it('a malformed sha is rejected syntactically and never reaches the checker', () => {
    const calls: string[] = [];
    const [e] = resolveEvidenceEdges(buildGraph(),
      [sig({ session: 'sess-1', commit: 'not-a-sha!' })],
      (sha) => { calls.push(sha); return true; });
    expect(e.metadata?.commitResolved).toBe(false);
    expect(calls).toEqual([]); // the syntactic gate short-circuits — garbage never shells out to git
  });

  it('with NO injected checker, falls back to syntactic validity (fail-soft, R2 behavior unchanged)', () => {
    const [valid] = resolveEvidenceEdges(buildGraph(), [sig({ session: 'sess-1', commit: '5615acb' })]);
    expect(valid.metadata?.commitResolved).toBe(true);
    const [bad] = resolveEvidenceEdges(buildGraph(), [sig({ session: 'sess-1', commit: 'xyz' })]);
    expect(bad.metadata?.commitResolved).toBe(false);
  });
});

// ─── Fail-soft, idempotent, never throws (the AC robustness clause) ──

describe('resolveEvidenceEdges — fail-soft, idempotent, robust', () => {
  it('an unresolvable session (no matching SessionEvent) → no edge, never a throw', () => {
    const edges = resolveEvidenceEdges(buildGraph(), [
      sig({ session: 'sess-does-not-exist', commit: 'deadbeef' }),
    ]);
    expect(edges).toHaveLength(0);
  });

  it('is idempotent: re-running over the same graph + signals yields identical edges', () => {
    const g = buildGraph();
    const signals = [sig({ session: 'sess-1', commit: '5615acb', symbols: ['src/auth/login.ts#login'] })];
    const first = resolveEvidenceEdges(g, signals);
    const second = resolveEvidenceEdges(g, signals);
    expect(second).toEqual(first);
    // and re-applying to the graph (overwrite by id) does not multiply edges
    for (const e of first) g.addRelationship(e);
    for (const e of second) g.addRelationship(e);
    const evidenceEdges = [...g.allRelationships()].filter(
      (e) => e.type === RelationshipType.EVIDENCED_BY || e.metadata?.tag === 'resolved',
    );
    expect(evidenceEdges).toHaveLength(first.length);
  });

  it('never throws on garbage evidence (empty / weird-but-typed values) — fail-soft', () => {
    const g = buildGraph();
    expect(() => resolveEvidenceEdges(g, [
      sig({ session: '', commit: '', symbols: ['', '   ', '🙂', 'x'.repeat(5000)] }),
      sig({ symbols: [] }),
      sig({ session: 'sess-1', commit: '   spaces  ', symbols: ['../../etc/passwd'] }),
    ])).not.toThrow();
    expect(resolveEvidenceEdges(g, [])).toEqual([]);
  });
});

// ─── Full chain: analyzeMarkdown(evidence frontmatter) → resolver ──

describe('evidence edges — analyzeMarkdown → resolveEvidenceEdges (the AC integration)', () => {
  it('harvests a block evidence:{session,commit,symbols} frontmatter into edges to real nodes', () => {
    const g = buildGraph();
    const md = [
      '---',
      'title: Auth Concept',
      'evidence:',
      '  session: sess-1',
      '  commit: 5615acb',
      '  symbols:',
      '    - src/auth/login.ts#login',
      '    - src/auth/login.ts',
      '---',
      '# Overview',
      'The auth flow.',
      '',
    ].join('\n');
    const result = analyzeMarkdown([{ path: '.wrxn/wiki/concepts/auth.md', content: md }]);
    expect(result.evidence).toEqual([
      { sourceId: PAGE_ID, session: 'sess-1', commit: '5615acb', symbols: ['src/auth/login.ts#login', 'src/auth/login.ts'] },
    ]);
    for (const n of result.nodes) g.addNode(n);

    const edges = resolveEvidenceEdges(g, result.evidence);
    const ev = edges.filter((e) => e.type === RelationshipType.EVIDENCED_BY);
    const doc = edges.filter((e) => e.type === RelationshipType.DOCUMENTED_BY);
    expect(ev.map((e) => e.targetId).sort()).toEqual(['event:sess-1:0', 'event:sess-1:1']);
    expect(ev.every((e) => e.metadata?.commit === '5615acb' && e.metadata?.commitResolved === true)).toBe(true);
    expect(doc.map((e) => e.targetId).sort()).toEqual(['ts:file:src/auth/login.ts', 'ts:func:login']);
    for (const e of edges) {
      expect(e.sourceId).toBe(PAGE_ID);
      expect(e.metadata?.tag).toBe('resolved');
    }
  });

  it('harvests the inline-flow evidence form too', () => {
    const md = [
      '---',
      'evidence: { session: sess-1, commit: 5615acb, symbols: [src/auth/login.ts] }',
      '---',
      '# H',
      'body',
    ].join('\n');
    const result = analyzeMarkdown([{ path: '.wrxn/wiki/concepts/auth.md', content: md }]);
    expect(result.evidence).toEqual([
      { sourceId: PAGE_ID, session: 'sess-1', commit: '5615acb', symbols: ['src/auth/login.ts'] },
    ]);
  });

  it('a page with no evidence: block harvests nothing (no throw)', () => {
    const result = analyzeMarkdown([{ path: 'docs/plain.md', content: '# Title\njust prose, no frontmatter\n' }]);
    expect(result.evidence).toEqual([]);
  });
});

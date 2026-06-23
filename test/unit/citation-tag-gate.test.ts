/**
 * Unit Tests: mandatory citation-tag correctness gate (citation-recon R3, #20, AC4)
 *
 * The gate that proves the R2 evidence resolver + `citationTag` tag every citation
 * CORRECTLY and DETERMINISTICALLY — the measurement that lets recon_explain's
 * resolved/inferred tag (and its verified-only view) be trusted. It runs the REAL
 * resolveEvidenceEdges over a gold fixture of KNOWN-resolvable and KNOWN-heuristic
 * citations (with the same injected commitExists the index wires) and checks each
 * emitted edge's effective tag against the fixture's expectation:
 *   • resolved  — target node provably exists AND (EVIDENCED_BY) the commit is in history.
 *   • inferred  — the link is emitted but its commit watermark is unverified
 *                 (well-formed but absent from history, or malformed) — the R3 fold.
 *   • no-edge   — precision-first: an unresolvable symbol yields NO edge (never a false resolved).
 *
 * Mirrors the decay-weight gate (docs/eval/0005): a harness over a gold fixture, a
 * forced-mistag fixture proving the gate has TEETH, and a durable report snapshotted
 * to docs/eval/0006 so any drift in the resolver's tagging fails CI.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { runGate, renderGateReport } from './citation-tag-gate.js';
import type { GateInput } from './citation-tag-gate.js';

// ─── The gold fixture graph: code + pages + session events ───────

const COMMIT_IN_HISTORY = '5615acb';       // present in the known-commits set
const COMMIT_ABSENT = 'abcdef0';           // well-formed (7 hex) but NOT in history

function node(id: string, name: string, o: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/x.ts', startLine: 1, endLine: 10,
    language: Language.TypeScript, package: 'src', exported: true, ...o,
  };
}

function buildGateGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  // a real code symbol (DOCUMENTED_BY target) + its File node
  g.addNode(node('ts:file:src/auth/login.ts', 'login.ts', {
    type: NodeType.File, file: 'src/auth/login.ts', startLine: 0, endLine: 0, package: 'src/auth',
  }));
  g.addNode(node('ts:func:login', 'login', { file: 'src/auth/login.ts', startLine: 5, endLine: 20, package: 'src/auth' }));
  // a real session's events (EVIDENCED_BY targets — R1 carries the sid as node.package)
  g.addNode(node('event:sess-1:0', 'prompt @ t0', {
    type: NodeType.SessionEvent, file: '.wrxn/events/sess-1.jsonl', startLine: 1, endLine: 1,
    language: Language.Json, package: 'sess-1', exported: false,
  }));
  // distinct source pages, one per case, so each signal owns its emitted edge(s)
  for (const p of ['resolved-session', 'inferred-commit', 'resolved-symbol', 'unresolvable-symbol']) {
    g.addNode(node(`md:page:${p}.md`, p, {
      type: NodeType.Page, file: `.wrxn/wiki/${p}.md`, language: Language.Markdown,
      package: '.wrxn/wiki', exported: false,
    }));
  }
  return g;
}

const GOLD: GateInput = {
  graph: buildGateGraph(),
  knownCommits: new Set([COMMIT_IN_HISTORY]), // the injected commitExists oracle
  cases: [
    {
      name: 'EVIDENCED_BY · session + in-history commit',
      kind: RelationshipType.EVIDENCED_BY,
      signal: { sourceId: 'md:page:resolved-session.md', session: 'sess-1', commit: COMMIT_IN_HISTORY, symbols: [] },
      expect: 'resolved',
    },
    {
      name: 'EVIDENCED_BY · session + well-formed-but-absent commit',
      kind: RelationshipType.EVIDENCED_BY,
      signal: { sourceId: 'md:page:inferred-commit.md', session: 'sess-1', commit: COMMIT_ABSENT, symbols: [] },
      expect: 'inferred',
    },
    {
      name: 'DOCUMENTED_BY · symbol resolves to a real node',
      kind: RelationshipType.DOCUMENTED_BY,
      signal: { sourceId: 'md:page:resolved-symbol.md', symbols: ['src/auth/login.ts#login'] },
      expect: 'resolved',
    },
    {
      name: 'DOCUMENTED_BY · unresolvable symbol (precision drops it)',
      kind: RelationshipType.DOCUMENTED_BY,
      signal: { sourceId: 'md:page:unresolvable-symbol.md', symbols: ['ghost'] },
      expect: 'no-edge',
    },
  ],
};

// ─── The gate PASSES the gold fixture (AC4) ──────────────────────

describe('runGate — the gold fixture: resolver tags every citation correctly', () => {
  const r = runGate(GOLD);

  it('verdict PASS — every case matches its expected tag', () => {
    expect(r.verdict).toBe('pass');
    expect(r.cases.every((c) => c.pass)).toBe(true);
  });

  it('a known-resolvable session+commit citation is tagged resolved', () => {
    expect(r.cases.find((c) => c.name.startsWith('EVIDENCED_BY · session + in-history'))?.actual).toBe('resolved');
  });

  it('a known-heuristic citation (commit absent from history) is tagged inferred (R3 fold)', () => {
    expect(r.cases.find((c) => c.name.startsWith('EVIDENCED_BY · session + well-formed'))?.actual).toBe('inferred');
  });

  it('a resolvable symbol is tagged resolved; an unresolvable one yields no edge (precision)', () => {
    expect(r.cases.find((c) => c.name.startsWith('DOCUMENTED_BY · symbol resolves'))?.actual).toBe('resolved');
    expect(r.cases.find((c) => c.name.startsWith('DOCUMENTED_BY · unresolvable'))?.actual).toBe('no-edge');
  });

  it('the resolver is deterministic (two passes byte-identical)', () => {
    expect(r.deterministic).toBe(true);
  });
});

// ─── The gate has TEETH: a mis-tag forces a FAIL verdict ─────────

describe('runGate — a mis-tagged expectation forces FAIL (the gate is not vacuous)', () => {
  it('expecting resolved for the absent-commit citation fails the gate', () => {
    const tampered: GateInput = {
      ...GOLD,
      cases: GOLD.cases.map((c) =>
        c.name.startsWith('EVIDENCED_BY · session + well-formed') ? { ...c, expect: 'resolved' } : c,
      ),
    };
    const r = runGate(tampered);
    expect(r.verdict).toBe('fail');
    expect(r.cases.find((c) => c.name.startsWith('EVIDENCED_BY · session + well-formed'))?.pass).toBe(false);
  });
});

// ─── The durable gate report (AC4) ───────────────────────────────

describe('renderGateReport — durable, deterministic record', () => {
  it('matches the committed report at docs/eval/0006-citation-tag-gate.md', () => {
    const report = renderGateReport(runGate(GOLD));
    const path = fileURLToPath(new URL('../../docs/eval/0006-citation-tag-gate.md', import.meta.url));
    expect(report).toMatchFileSnapshot(path);
  });
});

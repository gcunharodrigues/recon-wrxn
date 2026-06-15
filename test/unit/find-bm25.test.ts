/**
 * Unit Tests: executeFind BM25 fulltext path (recon-prose-analyzer-02)
 *
 * Slice 02 replaces find.ts's naive +2 exact / +1 substring fulltext scan with
 * BM25 ranking, injected behind the FulltextRanker interface. These tests lock:
 *
 *  1. the wiring — executeFind's fulltext branch ranks via the injected ranker;
 *  2. the retrieval flip — over the spike's 16 gold conceptual queries, the
 *     documenting page ranks top-5 AND outranks long sprawling pages, where the
 *     naive scan buries it (reproduces the spike RAW 0% → BM25 88% result);
 *  3. fidelity — code-only queries still surface the same relevant code nodes.
 *
 * The gold corpus here is a portable synthetic fixture that reproduces the real
 * structure the spike measured: concise concept pages whose discriminating terms
 * are rare (high IDF), vs. long sprawling pages built only from common terms
 * (low IDF, heavy length penalty). BM25's IDF + length-normalization float the
 * concept page; the naive cumulative scan lets the sprawl's bulk win — exactly
 * the failure the spike found. The real-corpus hit@5 is validated out-of-band.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { executeFind, classifyQuery, setFulltextRanker } from '../../src/mcp/find.js';
import { BM25Index } from '../../src/search/bm25.js';

// ─── Fixture builders ────────────────────────────────────────────

function page(file: string, name: string): Node {
  return {
    id: `md:page:${file}`,
    type: NodeType.Page,
    name,
    file,
    startLine: 1,
    endLine: 1,
    language: Language.Markdown,
    package: 'docs',
    exported: false,
  };
}

function code(id: string, name: string, file: string): Node {
  return {
    id,
    type: NodeType.Function,
    name,
    file,
    startLine: 1,
    endLine: 5,
    language: Language.TypeScript,
    package: 'src',
    exported: true,
  };
}

// The spike's 16 gold queries → [query, target file, concept page title, concept body].
// Each concept body carries the query's RARE terms (df=1 in this corpus); the body
// is short so length-normalization favors it.
const GOLD: Array<[string, string, string, string]> = [
  ['what enforces git push authority in this repo', '.wrxn/wiki/concepts/wrxn-git-push-authority-hook.md', 'WRXN Git Push Authority Hook',
    'the hook that enforces git push authority deciding who may push to the remote; push authority enforcement guard'],
  ['why is static import and orphan analysis unreliable here', '.wrxn/wiki/gotchas/static-analysis-unreliable.md', 'Static Analysis Unreliable',
    'static import and orphan analysis is unreliable because dynamic dispatch defeats the analyzer reliability'],
  ['how does the context engine inject rules and handle handoff', '.wrxn/wiki/concepts/synapse-activation.md', 'Synapse Activation',
    'the synapse context engine injects rules into the prompt and handles handoff at the token budget activation layers'],
  ['what is the prior art behind the documentation sync engine', '.wrxn/wiki/concepts/dox-doc-sync-pattern.md', 'Dox Doc Sync Pattern',
    'prior art behind the documentation sync engine; the dox doc synchronization pattern keeps docs aligned with code'],
  ['where is the catalog of available agent skills', '.wrxn/wiki/concepts/skills-catalog.md', 'Skills Catalog',
    'the catalog of available agent skills; the skills catalog lists every skill and its trigger'],
  ['does the first vercel deploy go straight to production', '.wrxn/wiki/concepts/vercel-first-deploy-goes-to-prod.md', 'Vercel First Deploy Goes To Prod',
    'the first vercel deploy goes straight to production; vercel deployment promotes to prod immediately'],
  ['where is the wrxn sales capabilities slide deck', '.wrxn/wiki/concepts/wrxn-capabilities-deck.md', 'WRXN Capabilities Deck',
    'the wrxn sales capabilities slide deck; the capabilities deck presents offerings to clients'],
  ['what are wrxn delivery and billing models', '.wrxn/wiki/concepts/wrxn-commercial-model.md', 'WRXN Commercial Model',
    'wrxn delivery and billing models; the commercial model covers retainer milestone and pricing billing'],
  ['spec for the session context surface interface', 'docs/frontend/frontend-spec.md', 'Frontend Spec',
    'specification for the session context surface interface; frontend spec of the surface component'],
  ['log of L5 squad context auto-wire false positives', 'docs/guides/l5-false-positive-log.md', 'L5 False Positive Log',
    'log of L5 squad context auto-wire false positives; false positive entries when squads wire context'],
  ['PRD for the aiox brain tier 2 context operating system', 'docs/prd/aiox-brain-tier2-context-os.prd.md', 'AIOX Brain Tier 2 Context OS',
    'requirements for the aiox brain tier two context operating system; the brain tier product requirements'],
  ['the plan for the project harvest protocol', 'docs/project-harvest-protocol-plan.md', 'Project Harvest Protocol Plan',
    'the plan for the project harvest protocol; harvesting project artifacts into the wiki protocol'],
  ['the wrxn-os phase 6 roadmap arc', 'docs/ROADMAP.md', 'Roadmap',
    'the wrxn os phase six roadmap arc; roadmap of milestones across phases'],
  ['what is the operator layer in the workspace profile', 'docs/workspace/operator-layer.md', 'Operator Layer',
    'the operator layer in the workspace profile; operator layer files seeded for the workspace profile'],
  ['wrxn-os system architecture and technical debt inventory', 'docs/architecture/system-architecture.md', 'System Architecture',
    'wrxn os system architecture and technical debt inventory; the architecture overview and debt register'],
  ['the final technical debt assessment report', 'docs/prd/technical-debt-assessment.md', 'Technical Debt Assessment',
    'the final technical debt assessment report; assessment of technical debt with remediation steps'],
];

// Long sprawling pages, built ONLY from common terms — the decisions-log / story
// pages that dominated the naive scan in the spike. No rare discriminating term.
const SPRAWL_FILES = [
  'decisions/log.md',
  'archives/story-3.5.md',
  'archives/story-3.3.md',
  'archives/doc-graph-impact.md',
  'archives/audit-aios.md',
  '.scratch/security-batch.md',
];
const COMMON = [
  'the', 'a', 'of', 'to', 'in', 'and', 'is', 'this', 'for', 'what', 'where', 'how',
  'does', 'are', 'at', 'here', 'wrxn', 'os', 'git', 'push', 'context', 'rule', 'hook',
  'agent', 'session', 'build', 'plan', 'log', 'story', 'phase', 'system', 'model',
  'repo', 'project', 'code',
];
const SPRAWL_BODY = (COMMON.join(' ') + ' ').repeat(50).trim();

function buildGoldGraph(): { graph: KnowledgeGraph; searchText: Record<string, string> } {
  const graph = new KnowledgeGraph();
  const searchText: Record<string, string> = {};

  for (const [, file, title, body] of GOLD) {
    const node = page(file, title);
    graph.addNode(node);
    searchText[node.id] = `${title} ${body}`;
  }
  for (const file of SPRAWL_FILES) {
    const node = page(file, 'Decisions Log');
    graph.addNode(node);
    searchText[node.id] = SPRAWL_BODY;
  }
  // Code noise — the baseline returned these for conceptual queries.
  for (const [id, name, file] of [
    ['ts:func:pushToRemote', 'pushToRemote', 'src/git/push.ts'],
    ['ts:func:gitCommit', 'gitCommit', 'src/git/commit.ts'],
    ['ts:cls:ReconWatcher', 'ReconWatcher', 'src/watcher.ts'],
    ['ts:func:loadConfig', 'loadConfig', 'src/config.ts'],
    ['ts:func:buildGraph', 'buildGraph', 'src/graph/build.ts'],
  ] as Array<[string, string, string]>) {
    graph.addNode(code(id, name, file));
  }

  // The real corpus is ~34k SHORT code symbols + a handful of huge prose pages.
  // That short-document majority is what pulls avgdl down so BM25's length-norm
  // crushes the long sprawling pages. Reproduce it with many short noise symbols
  // (names share no gold/sprawl terms → zero ranking pollution, avgdl effect only).
  for (let i = 0; i < 400; i++) {
    graph.addNode(code(`ts:sym:mod${i}`, `mod${i}`, `src/pkg${i % 12}/mod${i}.ts`));
  }

  return { graph, searchText };
}

// Reference: the arch map's REJECTED naive +2 exact / +1 substring scan extended
// over the prose body (the spike's `searchFulltextAugmented`). Returns files ranked
// desc. Used only as a control to prove BM25 beats it on the gold set.
function naiveBodyScan(
  graph: KnowledgeGraph,
  searchText: Record<string, string>,
  query: string,
): string[] {
  const tok = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const qt = tok(query);
  const scored: Array<{ file: string; score: number }> = [];
  for (const node of graph.nodes.values()) {
    const tokens = [...tok(node.name), ...tok(node.file), ...tok(searchText[node.id] ?? '')];
    let s = 0;
    for (const q of qt) {
      for (const t of tokens) {
        if (t === q) s += 2;
        else if (t.includes(q) || q.includes(t)) s += 1;
      }
    }
    if (s > 0) scored.push({ file: node.file, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.file);
}

// ─── Wiring ──────────────────────────────────────────────────────

describe('executeFind — BM25 fulltext ranker wiring', () => {
  afterEach(() => setFulltextRanker(null));

  it('fulltext branch ranks via the injected ranker — a body-only term finds the page', () => {
    const graph = new KnowledgeGraph();
    const p = page('docs/observability.md', 'Observability');
    graph.addNode(p);
    const ranker = BM25Index.buildFromGraph(graph, {
      [p.id]: 'Observability overview — the telemetry pipeline ships spans to the collector',
    });

    // Naive scan (no ranker) cannot match a body-only term…
    expect(executeFind(graph, 'telemetry pipeline spans')).toHaveLength(0);
    // …the injected BM25 ranker does.
    const ranked = executeFind(graph, 'telemetry pipeline spans', undefined, ranker);
    expect(ranked[0]?.file).toBe('docs/observability.md');
  });

  it('setFulltextRanker installs a process-default ranker for the live serve path', () => {
    const { graph, searchText } = buildGoldGraph();
    setFulltextRanker(BM25Index.buildFromGraph(graph, searchText));

    // No 4th arg — the default ranker (as serveCommand wires it) drives the live path.
    const top5 = executeFind(graph, 'does the first vercel deploy go straight to production', { limit: 5 })
      .map(r => r.file);
    expect(top5).toContain('.wrxn/wiki/concepts/vercel-first-deploy-goes-to-prod.md');
  });
});

// ─── Retrieval-quality regression (the gold flip) ────────────────

describe('gold-query retrieval regression (16 conceptual queries)', () => {
  let graph: KnowledgeGraph;
  let ranker: BM25Index;

  beforeEach(() => {
    const built = buildGoldGraph();
    graph = built.graph;
    ranker = BM25Index.buildFromGraph(built.graph, built.searchText);
  });

  it('BM25 ranks each gold target top-5 AND above every sprawling page', () => {
    let hit5 = 0;
    for (const [query, target] of GOLD) {
      const files = ranker
        .search(query, graph.nodeCount)
        .map(r => graph.getNode(r.nodeId)?.file);
      const tIdx = files.indexOf(target);

      expect(tIdx, `"${query}" → ${target} not retrieved`).toBeGreaterThanOrEqual(0);
      if (tIdx >= 0 && tIdx < 5) hit5++;

      // AC: concept page outranks the long sprawling pages.
      for (const sprawl of SPRAWL_FILES) {
        const sIdx = files.indexOf(sprawl);
        if (sIdx >= 0) {
          expect(tIdx, `"${query}": ${target} (#${tIdx}) must outrank ${sprawl} (#${sIdx})`)
            .toBeLessThan(sIdx);
        }
      }
    }
    // Spike's BM25 hit@5 was 88%; lock a conservative floor.
    expect(hit5 / GOLD.length).toBeGreaterThanOrEqual(0.8);
  });

  it('the rejected naive +2/+1 body-scan buries the target under the sprawl (BM25 floats it)', () => {
    // Reference implementation of the arch map's REJECTED proposal: extend the
    // find.ts scan to tokenize the prose body with the cumulative +2 exact / +1
    // substring scheme (no IDF, no length-normalization). The spike measured this
    // at hit@5 0% / median #304 — the sprawl's bulk wins. This locks slice 02
    // against anyone re-introducing that scorer in place of BM25.
    const built = buildGoldGraph();
    let naiveHit5 = 0;
    let bm25Hit5 = 0;
    for (const [query, target] of GOLD) {
      if (naiveBodyScan(built.graph, built.searchText, query).slice(0, 5).includes(target)) naiveHit5++;
      const bm25Files = ranker.search(query, graph.nodeCount).map(r => graph.getNode(r.nodeId)?.file);
      if (bm25Files.slice(0, 5).includes(target)) bm25Hit5++;
    }
    // Naive body-scan collapses (sprawl buries the concept page); BM25 rescues it.
    expect(naiveHit5 / GOLD.length).toBeLessThan(0.3);
    expect(bm25Hit5 / GOLD.length).toBeGreaterThanOrEqual(0.8);
    expect(bm25Hit5).toBeGreaterThan(naiveHit5);
  });

  it('live executeFind ranks the gold target top-5 over the fulltext-classified queries', () => {
    // The live classifier routes most conceptual queries to fulltext; one gold
    // query ("…orphan analysis…") trips the structural keyword "orphan" and is
    // diverted before fulltext — a pre-existing classifier behavior, out of scope.
    const fulltextGold = GOLD.filter(([q]) => classifyQuery(q) === 'fulltext');
    expect(fulltextGold.length).toBeGreaterThanOrEqual(15);

    let hits = 0;
    for (const [query, target] of fulltextGold) {
      if (executeFind(graph, query, { limit: 5 }, ranker).map(r => r.file).includes(target)) hits++;
    }
    expect(hits / fulltextGold.length).toBeGreaterThanOrEqual(0.8);
  });
});

// ─── Code-only fidelity (no regression) ──────────────────────────

describe('code-only fulltext fidelity', () => {
  function buildCodeGraph(): KnowledgeGraph {
    const g = new KnowledgeGraph();
    g.addNode(code('go:func:AuthHandler', 'AuthHandler', 'internal/auth/handler.go'));
    g.addNode(code('go:func:LoginHandler', 'LoginHandler', 'internal/auth/login.go'));
    g.addNode(code('go:func:handleAuth', 'handleAuth', 'internal/auth/middleware.go'));
    g.addNode(code('go:func:parseToken', 'parseToken', 'internal/jwt/parse.go'));
    g.addNode(code('go:func:getUserById', 'getUserById', 'internal/user/user.go'));
    return g;
  }

  it('BM25 surfaces the same relevant code nodes as the prior naive scan', () => {
    const g = buildCodeGraph();
    const ranker = BM25Index.buildFromGraph(g); // no searchText — pure code corpus

    // "login endpoint handler" — both schemes must surface LoginHandler in top-5.
    const bm25Login = executeFind(g, 'login endpoint handler', { limit: 5 }, ranker).map(r => r.name);
    const naiveLogin = executeFind(g, 'login endpoint handler', { limit: 5 }).map(r => r.name);
    expect(naiveLogin).toContain('LoginHandler');
    expect(bm25Login).toContain('LoginHandler');

    // "functions that handle authentication" — both surface an auth-related node.
    const bm25Auth = executeFind(g, 'functions that handle authentication', { limit: 5 }, ranker).map(r => r.name);
    expect(bm25Auth.some(n => n.toLowerCase().includes('auth'))).toBe(true);

    // No token overlap → graceful empty (matches prior behavior).
    expect(executeFind(g, 'completely unrelated xyz abc', undefined, ranker)).toEqual([]);
  });
});

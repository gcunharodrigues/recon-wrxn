/**
 * Unit Tests: freshness watermark footer on recon answers ([#9] D1)
 *
 * Every code-intelligence answer (recon_find, recon_explain, recon_impact) carries a
 * freshness footer `indexed @ <commit>, N files dirty`. The dirty count is an INJECTED
 * input to answer formatting (the freshness module computes it; the formatter never
 * computes it inline). When N > 0, an ABSENCE answer (impact with no callers/dependents,
 * find with no results) additionally carries an explicit "verify before acting on this
 * absence" warning; PRESENCE answers carry the footer only.
 *
 * Seam: handleToolCall (stdio / cold CLI) with a `freshness` watermark injected.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { handleToolCall } from '../../src/mcp/handlers.js';
import type { Freshness } from '../../src/mcp/freshness.js';

// ─── Minimal mock graph (callers chain) ─────────────────────────

function makeNode(id: string, name: string, overrides?: Partial<Node>): Node {
  return {
    id,
    type: NodeType.Function,
    name,
    file: 'internal/auth/auth.go',
    startLine: 1,
    endLine: 10,
    language: Language.Go,
    package: 'internal/auth',
    exported: true,
    ...overrides,
  };
}

function makeRel(
  sourceId: string,
  targetId: string,
  type: RelationshipType = RelationshipType.CALLS,
): Relationship {
  return { id: `${sourceId}-${type}-${targetId}`, type, sourceId, targetId, confidence: 1.0 };
}

function buildGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  // LoginHandler --CALLS--> ValidateToken (so ValidateToken has a caller, LoginHandler has none upstream)
  g.addNode(makeNode('go:func:LoginHandler', 'LoginHandler', { file: 'apps/api/login.go', package: 'apps/api' }));
  g.addNode(makeNode('go:func:ValidateToken', 'ValidateToken', { file: 'internal/auth/token.go' }));
  g.addRelationship(makeRel('go:func:LoginHandler', 'go:func:ValidateToken'));
  return g;
}

const DIRTY: Freshness = { commit: 'abc1234', dirty: 3 };
const CLEAN: Freshness = { commit: 'abc1234', dirty: 0 };

describe('[#9] freshness footer — recon_find presence', () => {
  let graph: KnowledgeGraph;
  beforeEach(() => { graph = buildGraph(); });

  it('a PRESENCE answer (results found) with a dirty watermark carries the footer and NO warning', async () => {
    const result = await handleToolCall(
      'recon_find', { query: 'Login' }, graph, undefined, undefined, DIRTY,
    );
    // footer: indexed @ <commit>, N files dirty
    expect(result).toContain('indexed @ abc1234, 3 files dirty');
    // presence → footer only, no absence warning
    expect(result.toLowerCase()).not.toContain('verify before acting');
    // and the actual answer is still present
    expect(result).toContain('LoginHandler');
  });
});

describe('[#9] freshness footer — recon_find absence × dirty/clean', () => {
  let graph: KnowledgeGraph;
  beforeEach(() => { graph = buildGraph(); });

  it('an ABSENCE answer (no results) with N > 0 carries the footer AND the verify-before-acting warning', async () => {
    const result = await handleToolCall(
      'recon_find', { query: 'NoSuchSymbolXyz' }, graph, undefined, undefined, DIRTY,
    );
    expect(result).toContain('No results found.');
    expect(result).toContain('indexed @ abc1234, 3 files dirty');
    expect(result.toLowerCase()).toContain('verify before acting on this absence');
  });

  it('an ABSENCE answer with N == 0 carries the footer ONLY (no warning)', async () => {
    const result = await handleToolCall(
      'recon_find', { query: 'NoSuchSymbolXyz' }, graph, undefined, undefined, CLEAN,
    );
    expect(result).toContain('No results found.');
    expect(result).toContain('indexed @ abc1234, 0 files dirty');
    expect(result.toLowerCase()).not.toContain('verify before acting');
  });
});

describe('[#9] freshness footer — recon_impact presence vs absence', () => {
  let graph: KnowledgeGraph;
  beforeEach(() => { graph = buildGraph(); });

  it('a PRESENCE impact (callers exist) with N > 0 carries the footer and NO warning', async () => {
    // ValidateToken has an upstream caller (LoginHandler) → non-empty blast radius.
    const result = await handleToolCall(
      'recon_impact', { target: 'ValidateToken', direction: 'upstream' },
      graph, undefined, undefined, DIRTY,
    );
    expect(result).toContain('LoginHandler');
    expect(result).toContain('indexed @ abc1234, 3 files dirty');
    expect(result.toLowerCase()).not.toContain('verify before acting');
  });

  it('an ABSENCE impact (no callers/dependents) with N > 0 carries the footer AND the warning', async () => {
    // LoginHandler has NO upstream caller → empty blast radius (absence).
    const result = await handleToolCall(
      'recon_impact', { target: 'LoginHandler', direction: 'upstream' },
      graph, undefined, undefined, DIRTY,
    );
    expect(result).toContain('0 total affected');
    expect(result).toContain('indexed @ abc1234, 3 files dirty');
    expect(result.toLowerCase()).toContain('verify before acting on this absence');
  });

  it('an ABSENCE impact with N == 0 carries the footer ONLY (no warning)', async () => {
    const result = await handleToolCall(
      'recon_impact', { target: 'LoginHandler', direction: 'upstream' },
      graph, undefined, undefined, CLEAN,
    );
    expect(result).toContain('0 total affected');
    expect(result).toContain('indexed @ abc1234, 0 files dirty');
    expect(result.toLowerCase()).not.toContain('verify before acting');
  });
});

describe('[#9] freshness footer — recon_explain is always footer-only (presence)', () => {
  let graph: KnowledgeGraph;
  beforeEach(() => { graph = buildGraph(); });

  it('explain carries the footer and NEVER an absence warning, even when dirty', async () => {
    const result = await handleToolCall(
      'recon_explain', { name: 'LoginHandler' }, graph, undefined, undefined, DIRTY,
    );
    expect(result).toContain('# Context: LoginHandler');
    expect(result).toContain('indexed @ abc1234, 3 files dirty');
    expect(result.toLowerCase()).not.toContain('verify before acting');
  });
});

describe('[#9] freshness footer — absent watermark leaves answers byte-identical (back-compat)', () => {
  let graph: KnowledgeGraph;
  beforeEach(() => { graph = buildGraph(); });

  it('no footer is appended when no freshness is injected (existing callers/tests unchanged)', async () => {
    const result = await handleToolCall('recon_find', { query: 'Login' }, graph);
    expect(result).not.toContain('indexed @');
    expect(result.toLowerCase()).not.toContain('verify before acting');
  });
});

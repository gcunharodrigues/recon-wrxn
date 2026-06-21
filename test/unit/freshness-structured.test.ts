/**
 * Unit Tests: freshness footer on the structured HTTP-door variants ([#9] D1)
 *
 * The HTTP door answers find/explain via findStructured/explainStructured, whose
 * markdown `result` must stay in parity with the stdio path — so the freshness footer
 * rides the structured `result` too when a watermark is injected, while the structured
 * sidecar (`hits` / `neighbors`) is unaffected (still the pure graph projection).
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { findStructured, explainStructured } from '../../src/mcp/handlers.js';
import type { Freshness } from '../../src/mcp/freshness.js';

function node(id: string, name: string, over?: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/a.ts', startLine: 1, endLine: 5,
    language: Language.TypeScript, package: 'src', exported: true, ...over,
  };
}
function rel(s: string, t: string, type = RelationshipType.CALLS): Relationship {
  return { id: `${s}-${type}-${t}`, type, sourceId: s, targetId: t, confidence: 1 };
}
function buildGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(node('f:mid', 'AuthMiddleware', { file: 'src/mw.ts', startLine: 11 }));
  g.addNode(node('f:vt', 'ValidateToken', { file: 'src/token.ts', startLine: 5 }));
  g.addRelationship(rel('f:mid', 'f:vt'));
  return g;
}

const DIRTY: Freshness = { commit: 'feed1234', dirty: 2 };

describe('[#9] freshness footer — structured HTTP-door variants', () => {
  it('findStructured presence: result carries the footer, hits unchanged', async () => {
    const { result, hits } = await findStructured(
      { query: 'Validate' }, buildGraph(), null, DIRTY,
    );
    expect(result).toContain('indexed @ feed1234, 2 files dirty');
    expect(result.toLowerCase()).not.toContain('verify before acting'); // presence
    expect(hits.length).toBeGreaterThan(0); // sidecar still populated
  });

  it('findStructured absence (no results) + dirty: result carries the footer AND warning', async () => {
    const { result, hits } = await findStructured(
      { query: 'NoSuchThingZzz' }, buildGraph(), null, DIRTY,
    );
    expect(result).toContain('No results found.');
    expect(result).toContain('indexed @ feed1234, 2 files dirty');
    expect(result.toLowerCase()).toContain('verify before acting on this absence');
    expect(hits).toEqual([]);
  });

  it('explainStructured: result carries the footer (presence only), neighbors unchanged', () => {
    const { result, neighbors } = explainStructured(
      { name: 'ValidateToken' }, buildGraph(), DIRTY,
    );
    expect(result).toContain('# Context: ValidateToken');
    expect(result).toContain('indexed @ feed1234, 2 files dirty');
    expect(result.toLowerCase()).not.toContain('verify before acting');
    expect(neighbors.find(n => n.name === 'AuthMiddleware')).toBeTruthy();
  });

  it('no watermark injected → structured result stays footer-free (back-compat)', async () => {
    const { result } = await findStructured({ query: 'Validate' }, buildGraph(), null);
    expect(result).not.toContain('indexed @');
  });
});

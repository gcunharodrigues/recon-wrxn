/**
 * Unit Tests: structured recon_explain over the HTTP door (recon-brain-recall-review #5)
 *
 * recon_explain used to return ONLY a markdown string, so the kernel CLI's
 * `wrxn brain query --neighbors` had no structured data and rendered empty. Mirroring
 * slice-01's findStructured, the door now returns { result, neighbors } where each
 * NeighborHit = { name, type, file, line, relationship }. The stdio MCP markdown stays
 * byte-identical (additive) — neighbors ride ALONGSIDE the unchanged `result`.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { createApp } from '../../src/server/http.js';
import { handleToolCall, explainStructured } from '../../src/mcp/handlers.js';

function node(id: string, name: string, over?: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/a.ts', startLine: 1, endLine: 5,
    language: Language.TypeScript, package: 'src', exported: true, ...over,
  };
}
function rel(s: string, t: string, type = RelationshipType.CALLS): Relationship {
  return { id: `${s}-${type}-${t}`, type, sourceId: s, targetId: t, confidence: 1 };
}

// AuthMiddleware → ValidateToken → DecodeJWT : ValidateToken has one caller + one callee.
function buildGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(node('f:mid', 'AuthMiddleware', { file: 'src/mw.ts', startLine: 11 }));
  g.addNode(node('f:vt', 'ValidateToken', { file: 'src/token.ts', startLine: 5 }));
  g.addNode(node('f:jwt', 'DecodeJWT', { file: 'src/jwt.ts', startLine: 3 }));
  g.addRelationship(rel('f:mid', 'f:vt'));
  g.addRelationship(rel('f:vt', 'f:jwt'));
  return g;
}

describe('recon_explain structured neighbors (recon-brain-recall-review #5)', () => {
  it('explainStructured returns NeighborHit[] with name/type/file/line/relationship', () => {
    const { result, neighbors } = explainStructured({ name: 'ValidateToken' }, buildGraph());

    expect(result).toContain('# Context: ValidateToken'); // markdown still produced
    const caller = neighbors.find(n => n.name === 'AuthMiddleware');
    const callee = neighbors.find(n => n.name === 'DecodeJWT');

    expect(caller).toMatchObject({
      name: 'AuthMiddleware', type: NodeType.Function, file: 'src/mw.ts', relationship: 'caller',
    });
    expect(typeof caller!.line).toBe('number');
    expect(callee).toMatchObject({ name: 'DecodeJWT', relationship: 'callee' });
  });

  it('door POST /api/tools/recon_explain returns { result, neighbors }', async () => {
    const app = createApp({ port: 0, graph: buildGraph() });
    const res = await request(app).post('/api/tools/recon_explain').send({ name: 'ValidateToken' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.neighbors)).toBe(true);

    const rels = (res.body.neighbors as Array<{ relationship: string }>).map(n => n.relationship);
    expect(rels).toContain('caller');
    expect(rels).toContain('callee');

    for (const n of res.body.neighbors as Array<Record<string, unknown>>) {
      expect(typeof n.name).toBe('string');
      expect(typeof n.type).toBe('string');
      expect(typeof n.file).toBe('string');
      expect(typeof n.line).toBe('number');
      expect(typeof n.relationship).toBe('string');
    }
  });

  it('the door recon_explain markdown `result` is byte-identical to stdio (additive)', async () => {
    const graph = buildGraph();
    const app = createApp({ port: 0, graph });
    const res = await request(app).post('/api/tools/recon_explain').send({ name: 'ValidateToken' });
    const stdio = await handleToolCall('recon_explain', { name: 'ValidateToken' }, graph);
    expect(res.body.result).toBe(stdio);
  });

  it('empty neighbors + byte-identical error markdown for an unknown symbol', async () => {
    const graph = buildGraph();
    const { result, neighbors } = explainStructured({ name: 'NoSuchSymbol' }, graph);
    expect(neighbors).toEqual([]);
    expect(result).toBe(await handleToolCall('recon_explain', { name: 'NoSuchSymbol' }, graph));
  });
});

// ─── citation neighbors carry the resolved/inferred tag (R3, #20) ──

describe('recon_explain structured citation neighbors (citation-recon R3, #20)', () => {
  const PAGE = 'md:page:.wrxn/wiki/concepts/auth.md';

  // A Page that cites a session (EVIDENCED_BY → SessionEvent) and a code symbol
  // (DOCUMENTED_BY → ValidateToken), each tagged as R2 stamps them.
  function citationGraph(commitResolved = true): KnowledgeGraph {
    const g = buildGraph();
    g.addNode(node(PAGE, 'Auth Evidence Page', {
      type: NodeType.Page, file: '.wrxn/wiki/concepts/auth.md',
      language: Language.Markdown, package: '.wrxn/wiki/concepts', exported: false,
    }));
    g.addNode(node('event:sess-1:0', 'prompt @ t0', {
      type: NodeType.SessionEvent, file: '.wrxn/events/sess-1.jsonl', startLine: 1,
      language: Language.Json, package: 'sess-1', exported: false,
    }));
    g.addRelationship({
      id: `${PAGE}-EVIDENCED_BY-event`, type: RelationshipType.EVIDENCED_BY,
      sourceId: PAGE, targetId: 'event:sess-1:0', confidence: 0.9,
      metadata: { tag: 'resolved', commit: '5615acb', commitResolved },
    });
    g.addRelationship({
      id: `${PAGE}-DOCUMENTED_BY-vt`, type: RelationshipType.DOCUMENTED_BY,
      sourceId: PAGE, targetId: 'f:vt', confidence: 0.9, metadata: { tag: 'resolved' },
    });
    return g;
  }

  it('a PAGE surfaces evidencedBy + documents neighbors, each carrying its tag', () => {
    const { neighbors } = explainStructured({ name: 'Auth Evidence Page' }, citationGraph());
    expect(neighbors.find(n => n.relationship === 'evidencedBy')).toMatchObject({
      name: 'prompt @ t0', relationship: 'evidencedBy', tag: 'resolved', commit: '5615acb',
    });
    expect(neighbors.find(n => n.relationship === 'documents')).toMatchObject({
      name: 'ValidateToken', relationship: 'documents', tag: 'resolved',
    });
  });

  it('an EVIDENCED_BY edge whose commit does not resolve is tagged inferred', () => {
    const { neighbors } = explainStructured({ name: 'Auth Evidence Page' }, citationGraph(false));
    expect(neighbors.find(n => n.relationship === 'evidencedBy')?.tag).toBe('inferred');
  });

  it('verified:true drops the inferred neighbor from the structured view, keeps resolved ones', () => {
    const { neighbors } = explainStructured({ name: 'Auth Evidence Page', verified: true }, citationGraph(false));
    expect(neighbors.some(n => n.relationship === 'evidencedBy')).toBe(false); // inferred → dropped
    expect(neighbors.some(n => n.relationship === 'documents')).toBe(true);    // resolved → kept
  });
});

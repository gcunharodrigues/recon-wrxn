/**
 * Unit Tests: structured recon_drift over the HTTP door (sync-08)
 *
 * recon_drift used to fall through to the generic { result } door path — markdown
 * ONLY — so the kernel sync loop (sync-04 `summarizeDrift`) read parsed.stale /
 * parsed.unwatermarked, which never existed on that body → coerced to [] →
 * status:"synced" even when the door's own markdown said a doc was stale. Mirroring
 * find's `hits` and explain's `neighbors`, the door now returns { result, drift }
 * where `drift` is the full structured DriftReport. The stdio MCP markdown stays
 * byte-identical (additive) — `drift` rides ALONGSIDE the unchanged `result`.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node, Relationship } from '../../src/graph/types.js';
import { ANCHOR_CONFIDENCE } from '../../src/analyzers/doc-edges.js';
import { createApp } from '../../src/server/http.js';
import { handleToolCall, driftStructured } from '../../src/mcp/handlers.js';

function symbol(id: string, name: string, over?: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/auth.ts', startLine: 10, endLine: 20,
    language: Language.TypeScript, package: 'src', exported: true, ...over,
  };
}
function page(id: string, name: string, over?: Partial<Node>): Node {
  return {
    id, type: NodeType.Page, name, file: 'docs/auth.md', startLine: 1, endLine: 40,
    language: Language.Markdown, package: 'docs', exported: false, ...over,
  };
}
function docEdge(pageId: string, symbolId: string, confidence: number): Relationship {
  return {
    id: `${pageId}-DOCUMENTED_BY-${symbolId}`,
    type: RelationshipType.DOCUMENTED_BY,
    sourceId: pageId, targetId: symbolId, confidence,
  };
}

// One watermarked derived page whose source symbol's fingerprint has MOVED → 1 stale.
function buildStaleGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(symbol('ts:func:login', 'login', { fingerprint: 'aaaaaaaaaaaaaaaa' }));
  g.addNode(page('md:page:docs/auth.md', 'Auth Guide', { syncedTo: 'bbbbbbbbbbbbbbbb' }));
  g.addRelationship(docEdge('md:page:docs/auth.md', 'ts:func:login', ANCHOR_CONFIDENCE));
  return g;
}

describe('recon_drift structured sidecar (sync-08)', () => {
  it('driftStructured returns the full DriftReport with one structured stale entry', () => {
    const { result, drift } = driftStructured({}, buildStaleGraph());

    // markdown still produced + names the stale entry
    expect(result).toContain('# Drift Report');
    expect(result).toContain('login');

    expect(drift.stale).toHaveLength(1);
    expect(drift.stale[0]).toMatchObject({
      page: 'Auth Guide',
      symbol: 'login',
      syncedTo: 'bbbbbbbbbbbbbbbb',
      current: 'aaaaaaaaaaaaaaaa',
    });
    // the other buckets are present + empty (the stable shape the kernel reads)
    expect(drift.unwatermarked).toEqual([]);
    expect(drift.multiAnchor).toEqual([]);
    expect(drift.uncomparable).toEqual([]);
    expect(typeof drift.fresh).toBe('number');
  });

  it('door POST /api/tools/recon_drift returns { result, drift } with drift.stale', async () => {
    const app = createApp({ port: 0, graph: buildStaleGraph() });
    const res = await request(app).post('/api/tools/recon_drift').send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.result).toBe('string');
    expect(Array.isArray(res.body.drift.stale)).toBe(true);
    expect(res.body.drift.stale).toHaveLength(1);
    expect(res.body.drift.stale[0]).toMatchObject({
      page: 'Auth Guide',
      symbol: 'login',
      syncedTo: 'bbbbbbbbbbbbbbbb',
      current: 'aaaaaaaaaaaaaaaa',
    });
    // the full report shape rides the door (the cross-repo contract the kernel reads)
    expect(res.body.drift).toMatchObject({
      unwatermarked: [], multiAnchor: [], uncomparable: [],
    });
    expect(typeof res.body.drift.fresh).toBe('number');
  });

  it('the door recon_drift markdown `result` is byte-identical to stdio (additive)', async () => {
    const graph = buildStaleGraph();
    const app = createApp({ port: 0, graph });
    const res = await request(app).post('/api/tools/recon_drift').send({});
    const stdio = await handleToolCall('recon_drift', {}, graph);
    expect(res.body.result).toBe(stdio);
  });

  it('empty drift report + byte-identical empty-graph markdown on an empty graph', async () => {
    const graph = new KnowledgeGraph();
    const { result, drift } = driftStructured({}, graph);
    expect(drift).toEqual({
      stale: [], unwatermarked: [], multiAnchor: [], uncomparable: [], fresh: 0,
    });
    // mirrors handleToolCall's empty-graph guard so the markdown matches stdio exactly
    expect(result).toBe(await handleToolCall('recon_drift', {}, graph));
  });
});

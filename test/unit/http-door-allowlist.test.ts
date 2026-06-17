/**
 * Unit Tests: HTTP door route allowlist (recon-brain-recall-review, finding #1)
 *
 * The POST /api/tools/:name handler (shared by the warm query door AND the legacy
 * --http dashboard) used to forward ANY :name to handleToolCall, exposing all 8
 * tools — including recon_changes (a git shell-out). Only the two READ-ONLY tools
 * the kernel hook + `wrxn brain query --neighbors` use are reachable now; every
 * other name is refused with 403 BEFORE handleToolCall runs.
 *
 * handlers.js is mocked to wrap handleToolCall in a spy (calling through), so a
 * rejected tool can be proven to NEVER reach it. findStructured/explainStructured
 * (the real implementations the two allowed tools route through) are kept real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import { createApp } from '../../src/server/http.js';
import { handleToolCall } from '../../src/mcp/handlers.js';
import type { Express } from 'express';

vi.mock('../../src/mcp/handlers.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/mcp/handlers.js')>();
  return { ...actual, handleToolCall: vi.fn(actual.handleToolCall) };
});

function appWithOneNode(): Express {
  const g = new KnowledgeGraph();
  g.addNode({
    id: 'f1', type: NodeType.Function, name: 'GetUser', file: 'handler/user.go',
    startLine: 1, endLine: 10, language: Language.Go, package: 'handler', exported: true,
  });
  return createApp({ port: 0, graph: g });
}

describe('POST /api/tools/:name — door route allowlist (recon-brain-recall-review)', () => {
  let app: Express;
  beforeEach(() => {
    vi.clearAllMocks();
    app = appWithOneNode();
  });

  it('allows recon_find (200)', async () => {
    const res = await request(app).post('/api/tools/recon_find').send({ query: 'GetUser' });
    expect(res.status).toBe(200);
  });

  it('allows recon_explain (200)', async () => {
    const res = await request(app).post('/api/tools/recon_explain').send({ name: 'GetUser' });
    expect(res.status).toBe(200);
  });

  // sync-03 AC6: recon_drift is read-only + git-free → door-eligible (not 403).
  // sync-08: it now rides its own structured `drift` sidecar (like find's `hits` /
  // explain's `neighbors`), so it routes through driftStructured — NOT the generic
  // handleToolCall path — and the body carries both `result` and `drift`.
  it('allows recon_drift (200, structured sidecar — not 403)', async () => {
    const res = await request(app).post('/api/tools/recon_drift').send({});
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(403);
    // Rides the structured sidecar → does NOT reach the generic handleToolCall path.
    expect(handleToolCall).not.toHaveBeenCalled();
    expect(res.body.result).toContain('Drift Report');
    expect(res.body.drift).toBeDefined();
  });

  const DISALLOWED = [
    'recon_changes', 'recon_rename', 'recon_export',
    'recon_map', 'recon_impact', 'recon_rules', 'nonexistent_tool',
  ];

  for (const tool of DISALLOWED) {
    it(`rejects ${tool} with 403 and never reaches handleToolCall`, async () => {
      const res = await request(app).post(`/api/tools/${tool}`).send({ query: 'x', target: 'x', name: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      // 403 is a status the handleToolCall path can never produce (it yields 200, or
      // 400 on throw) — combined with the spy, proof the request short-circuited.
      expect(handleToolCall).not.toHaveBeenCalled();
    });
  }
});

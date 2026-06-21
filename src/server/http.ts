/**
 * HTTP REST API Server
 *
 * Express server that wraps MCP tool handlers and resources as REST endpoints.
 * Also serves the interactive web dashboard at the root path.
 *
 *   GET  /                    — web dashboard
 *   GET  /api/health          — health check + index stats
 *   GET  /api/tools           — list available tools
 *   POST /api/tools/:name     — execute a tool (body = params)
 *   GET  /api/resources       — list MCP resources + templates
 *   GET  /api/resources/read  — read a resource (?uri=...)
 *   GET  /api/graph           — graph data for vis-network
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import type { KnowledgeGraph } from '../graph/graph.js';
import type { VectorStoreSource } from '../mcp/server.js';
import { RECON_TOOLS } from '../mcp/tools.js';
import { handleToolCall, findStructured, explainStructured, driftStructured } from '../mcp/handlers.js';
import { computeFreshness } from '../mcp/freshness.js';

import {
  getResourceDefinitions,
  getResourceTemplates,
  readResource,
} from '../mcp/resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The HTTP door (and the legacy --http dashboard) expose ONLY these read-only,
 * git-free tools — the ones the kernel recall hook, `wrxn brain query --neighbors`,
 * and the sync loop (sync-04) reach over the serve door. recon_drift joins the
 * door because it is a PURE indexed-graph compare with no git/shell-out (sync-03
 * AC6). Every other tool name is refused with 403 BEFORE reaching handleToolCall,
 * keeping recon_changes (a git shell-out) and the other mutating/heavier tools off
 * the HTTP surface entirely (recon-brain-recall-review, finding #1).
 */
const DOOR_TOOLS = new Set(['recon_find', 'recon_explain', 'recon_drift']);

export interface HttpServerOptions {
  port: number;
  host?: string;
  graph: KnowledgeGraph;
  projectRoot?: string;
  /**
   * Either a fixed value (back-compat — tests, a cold HTTP serve) OR a getter
   * resolved on EACH request. serve passes `() => liveStore` so the find door sees
   * the mid-session embedding hot-swap, mirroring the stdio path (recon-brain-recall-01).
   */
  vectorStore?: VectorStoreSource;
  /**
   * The graph's indexed short commit (from IndexMeta.gitCommit). The freshness
   * watermark ([#9]) is computed PER REQUEST from git against projectRoot using this
   * as the comparison base, so the footer reflects the live dirty count at answer time.
   * Absent → no footer (back-compat: tests, callers that don't wire it).
   */
  indexedCommit?: string;
}

/**
 * Create the Express app (exported for testing without listen).
 */
export function createApp(options: HttpServerOptions): express.Express {
  const { graph, projectRoot, vectorStore, indexedCommit } = options;
  const app = express();

  app.use(cors({
    origin: [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/],
  }));
  app.use(express.json());

  // ─── Static dashboard ───────────────────────────────────────

  const dashboardDir = join(__dirname, '..', 'dashboard');
  if (existsSync(dashboardDir)) {
    app.use(express.static(dashboardDir));
  }

  // ─── GET /api/health ────────────────────────────────────────

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      nodes: graph.nodeCount,
      relationships: graph.relationshipCount,
      tools: RECON_TOOLS.length,
    });
  });

  // ─── GET /api/tools ─────────────────────────────────────────

  app.get('/api/tools', (_req, res) => {
    res.json({
      tools: RECON_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  });

  // ─── POST /api/tools/:name ──────────────────────────────────

  app.post('/api/tools/:name', async (req, res) => {
    const { name } = req.params;
    const args = req.body as Record<string, unknown> | undefined;

    // Route allowlist: only the two read-only tools are reachable; anything else is
    // refused here, before handleToolCall ever runs (recon-brain-recall-review #1).
    if (!DOOR_TOOLS.has(name)) {
      res.status(403).json({
        error: `Tool '${name}' is not available on the HTTP door (allowed: recon_find, recon_explain, recon_drift).`,
      });
      return;
    }

    // Resolve the store through the live getter (when one was passed) so a mid-session
    // embedding hot-swap is seen on THIS request — not a by-value snapshot captured at
    // createApp (recon-brain-recall-01). Mirrors the stdio CallTool resolution.
    const vs = typeof vectorStore === 'function' ? vectorStore() : vectorStore;

    // Compute the freshness watermark at ANSWER TIME ([#9]): the live dirty count from
    // git against projectRoot, with the indexed commit as the comparison base. Injected
    // into the formatters (never computed inside them). Skipped when projectRoot/commit
    // are absent → no footer (back-compat). The single git read never re-indexes.
    const freshness =
      projectRoot && indexedCommit
        ? computeFreshness({ projectRoot, indexedCommit })
        : undefined;

    try {
      // recon_find additionally surfaces the structured per-hit signal (cosine + arm
      // provenance) for node-stdlib consumers (the Recall hook); the markdown `result`
      // carries the freshness footer in parity with the stdio output. Every other tool
      // returns { result }.
      if (name === 'recon_find') {
        const { result, hits } = await findStructured(args, graph, vs, freshness);
        res.json({ result, hits });
        return;
      }
      // recon_explain mirrors the find door: structured `neighbors` (the caller/callee/
      // import/… graph the `--neighbors` view reads) ride ALONGSIDE the markdown, which
      // carries the freshness footer in parity with the stdio output (recon-brain-recall-review #5).
      if (name === 'recon_explain') {
        const { result, neighbors } = explainStructured(args, graph, freshness);
        res.json({ result, neighbors });
        return;
      }
      // recon_drift rides a structured `drift` sidecar — the full DriftReport
      // ({ stale, unwatermarked, multiAnchor, uncomparable, fresh }) — ALONGSIDE the
      // markdown, which stays byte-identical to the stdio output (sync-08). CROSS-REPO
      // CONTRACT: the kernel sync loop (sync-04 sync.cjs) reads `parsed.drift.stale`
      // and `parsed.drift.unwatermarked` off this body; mirrors the find `hits` /
      // explain `neighbors` sidecars. Without it recon_drift fell to the generic
      // { result } path below — markdown only — so the kernel saw no stale set.
      if (name === 'recon_drift') {
        const { result, drift } = driftStructured(args, graph);
        res.json({ result, drift });
        return;
      }
      const result = await handleToolCall(
        name,
        args,
        graph,
        projectRoot,
        vs,
      );
      res.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  // ─── GET /api/resources ─────────────────────────────────────

  app.get('/api/resources', (_req, res) => {
    res.json({
      resources: getResourceDefinitions(),
      templates: getResourceTemplates(),
    });
  });

  // ─── GET /api/resources/read?uri=... ─────────────────────────
  // Resource URI passed as query param to avoid path issues with ://

  app.get('/api/resources/read', (req, res) => {
    const uri = req.query.uri as string;

    if (!uri) {
      res.status(400).json({ error: 'Missing ?uri= query parameter' });
      return;
    }

    try {
      const content = readResource(uri, graph);
      res.json({ uri, content });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: message });
    }
  });

  // ─── GET /api/graph ─────────────────────────────────────────
  // Returns nodes + edges formatted for vis-network visualization.

  app.get('/api/graph', (req, res) => {
    const limit = Math.min(
      parseInt(req.query.limit as string, 10) || 300,
      2000,
    );
    const typeFilter = req.query.type as string | undefined;
    const pkgFilter = req.query.package as string | undefined;

    // Structural edge types to skip (clutter the visualization)
    // Note: DEFINES is kept because for TS-only projects it may be the only edge type
    const SKIP_EDGE_TYPES = new Set(['CONTAINS']);

    // Compute degree for each node (non-structural edges only)
    const degrees = new Map<string, number>();
    for (const rel of graph.allRelationships()) {
      if (SKIP_EDGE_TYPES.has(rel.type)) continue;
      degrees.set(rel.sourceId, (degrees.get(rel.sourceId) || 0) + 1);
      degrees.set(rel.targetId, (degrees.get(rel.targetId) || 0) + 1);
    }

    // Filter nodes
    let candidates = [...graph.nodes.values()];
    if (typeFilter) {
      candidates = candidates.filter(n => n.type === typeFilter);
    }
    if (pkgFilter) {
      candidates = candidates.filter(n => n.package?.includes(pkgFilter));
    }

    // Sort by degree (most connected first) for interesting subgraph
    candidates.sort((a, b) =>
      (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0),
    );

    const selected = candidates.slice(0, limit);
    const nodeIds = new Set(selected.map(n => n.id));

    // Format nodes for vis-network
    const nodes = selected.map(n => ({
      id: n.id,
      label: n.name,
      group: n.type,
      value: degrees.get(n.id) || 1,
      language: n.language,
      file: n.file,
      startLine: n.startLine,
      endLine: n.endLine,
      package: n.package,
      exported: n.exported,
      community: n.community,
    }));

    // Edges: only where both endpoints are visible, skip structural
    const edges: Array<{
      from: string;
      to: string;
      label: string;
    }> = [];

    for (const rel of graph.allRelationships()) {
      if (SKIP_EDGE_TYPES.has(rel.type)) continue;
      if (nodeIds.has(rel.sourceId) && nodeIds.has(rel.targetId)) {
        edges.push({
          from: rel.sourceId,
          to: rel.targetId,
          label: rel.type,
        });
      }
    }

    res.json({
      nodes,
      edges,
      stats: {
        totalNodes: graph.nodeCount,
        totalEdges: graph.relationshipCount,
        shownNodes: nodes.length,
        shownEdges: edges.length,
      },
    });
  });

  // ─── Body-parse error handler (must be registered AFTER the routes) ──
  // express.json() throws a SyntaxError BEFORE any handler runs when the request
  // body is malformed JSON. Without this, express's default path answers 400 but
  // logs the full stack to stderr — serve's MCP-client log (recon-brain-recall-06).
  // Convert ONLY that parse failure to a clean JSON 400; everything else falls
  // through to express's default error handling untouched.
  app.use((
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (
      err instanceof SyntaxError &&
      (err as { type?: string }).type === 'entity.parse.failed'
    ) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    next(err);
  });

  return app;
}

/**
 * Start the HTTP server.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<void> {
  const app = createApp(options);
  const { port } = options;
  const host = options.host ?? '127.0.0.1';

  return new Promise((resolve) => {
    app.listen(port, host, () => {
      console.log(`recon-wrxn HTTP server: http://${host}:${port}`);
      if (host === '0.0.0.0') {
        console.log('WARNING: Exposing recon-wrxn on all interfaces.');
      }
      resolve();
    });
  });
}

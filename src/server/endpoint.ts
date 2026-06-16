/**
 * Serve discovery — the concurrent HTTP query door + its endpoint file.
 *
 * When `serve` runs the stdio MCP transport with the `serveHttp` gate on, it ALSO
 * binds the read-only Express find app (createApp) on 127.0.0.1 on an OS-assigned
 * port, in the SAME process, and announces the live endpoint in a discovery file —
 * `.recon-wrxn/serve-endpoint.json` carrying `{ pid, port }`. A short-lived client
 * (a kernel recall hook, `wrxn brain query`) reads that file to reach the one warm
 * index instead of paying for a second cold serve.
 *
 * The `{ pid, port }` JSON shape is a CROSS-REPO contract: the kernel mirrors this
 * exact format in its own node-stdlib reader. Keep it minimal and stable.
 * (recon-brain-recall-02, implements ADR 0003.)
 */
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from './http.js';
import type { KnowledgeGraph } from '../graph/graph.js';
import type { VectorStoreSource } from '../mcp/server.js';

/** The discovery-file payload. The cross-repo contract — extend with care. */
export interface ServeEndpoint {
  pid: number;
  port: number;
}

/** A live query door: the real assigned port + a best-effort shutdown closer. */
export interface QueryDoorHandle {
  port: number;
  /** Remove the discovery file + close the listener. Safe to call once on exit. */
  close: () => void;
}

const ENDPOINT_FILENAME = 'serve-endpoint.json';

function endpointPath(reconDir: string): string {
  return join(reconDir, ENDPOINT_FILENAME);
}

/** Announce the live endpoint. Ensures the index dir exists first. The file is
 *  created owner-read/write only (0600) so a co-located user cannot read the live
 *  port — defense-in-depth with the kernel-side ownership check (review #4). */
export function writeEndpoint(reconDir: string, endpoint: ServeEndpoint): void {
  mkdirSync(reconDir, { recursive: true });
  writeFileSync(endpointPath(reconDir), JSON.stringify(endpoint), { encoding: 'utf-8', mode: 0o600 });
}

/** Best-effort removal — a missing file or transient FS error never throws. */
export function removeEndpoint(reconDir: string): void {
  try {
    rmSync(endpointPath(reconDir), { force: true });
  } catch {
    // best-effort: shutdown cleanup must never crash serve.
  }
}

/**
 * Resolve the live endpoint, or null ("not warm") when the file is absent,
 * malformed, the wrong shape, or its announced pid is NOT a live process. The
 * pid liveness probe is what makes a stale file (left by a SIGKILLed serve)
 * safe to ignore.
 */
export function readEndpoint(reconDir: string): ServeEndpoint | null {
  let raw: string;
  try {
    raw = readFileSync(endpointPath(reconDir), 'utf-8');
  } catch {
    return null; // absent / unreadable
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { pid, port } = parsed as Record<string, unknown>;
  if (typeof pid !== 'number' || typeof port !== 'number') return null; // wrong shape
  if (!isProcessAlive(pid)) return null; // dead pid → not warm

  return { pid, port };
}

/**
 * Liveness probe via `process.kill(pid, 0)` — signal 0 sends nothing, it only
 * checks deliverability. EPERM means the process exists but is owned by another
 * user (still alive); ESRCH (and anything else) means no such process.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The serve-orchestration gate. When `serveHttp` is on, bind the read-only find
 * app on 127.0.0.1 on an OS-assigned port (listen on 0, read the real port back),
 * write the discovery file, and return a handle; when off, return null so serve
 * starts only stdio. Stdio is started UNCONDITIONALLY by the caller right after —
 * the door runs ALONGSIDE it, never replaces it.
 */
export async function maybeStartQueryDoor(opts: {
  serveHttp: boolean;
  reconDir: string;
  graph: KnowledgeGraph;
  projectRoot?: string;
  vectorStore?: VectorStoreSource;
}): Promise<QueryDoorHandle | null> {
  if (!opts.serveHttp) return null;

  const app = createApp({
    port: 0,
    graph: opts.graph,
    projectRoot: opts.projectRoot,
    vectorStore: opts.vectorStore,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('[recon] query door: could not read the OS-assigned port');
  }
  const port = addr.port;

  writeEndpoint(opts.reconDir, { pid: process.pid, port });

  return {
    port,
    close: () => {
      removeEndpoint(opts.reconDir);
      try {
        server.close();
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Fail-open wrapper around maybeStartQueryDoor (recon-brain-recall-review #3).
 *
 * The query door is a best-effort convenience — it must NEVER stop serve from
 * starting its ESSENTIAL stdio transport. A bind/listen/FS error (EADDRINUSE,
 * EACCES, a watch failure …) is logged to stderr and swallowed so serve continues
 * stdio-only (door = null). The `starter` seam is injectable for testing.
 */
export async function startQueryDoorSafe(
  opts: Parameters<typeof maybeStartQueryDoor>[0],
  starter: typeof maybeStartQueryDoor = maybeStartQueryDoor,
): Promise<QueryDoorHandle | null> {
  try {
    return await starter(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[recon] query door failed to start (${msg}); continuing stdio-only.`);
    return null;
  }
}

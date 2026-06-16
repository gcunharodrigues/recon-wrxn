/**
 * Unit Tests: concurrent serve discovery — endpoint file + query-door orchestration
 * (recon-brain-recall-02, implements ADR 0003).
 *
 * Two concerns:
 *  (1) The discovery FILE format `.recon-wrxn/serve-endpoint.json` = `{pid,port}`.
 *      This JSON shape is a CROSS-REPO contract: the kernel mirrors it in its own
 *      stdlib reader. writeEndpoint/readEndpoint round-trip it; the reader treats
 *      absent / malformed / dead-pid files as "not warm" (returns null) — verifying
 *      the announced process is alive via a `process.kill(pid, 0)` liveness probe
 *      before trusting the endpoint.
 *  (2) The serve-orchestration gate: maybeStartQueryDoor binds the read-only find
 *      app on 127.0.0.1 on an OS-assigned port ONLY when the serveHttp gate is on,
 *      announcing the real assigned port; off ⇒ no bind, no file (serve unchanged).
 *      Stdio is started UNCONDITIONALLY by serveCommand right after this call, so the
 *      gate adds the door ALONGSIDE stdio — it never replaces it.
 *
 * The door test does a real loopback bind on port 0 (localhost, fast) to genuinely
 * prove the concurrent door comes up + answers, rather than mocking the socket.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  writeEndpoint,
  removeEndpoint,
  readEndpoint,
  maybeStartQueryDoor,
} from '../../src/server/endpoint.js';
import type { QueryDoorHandle } from '../../src/server/endpoint.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import { loadConfig, initConfig } from '../../src/config/config.js';

const ENDPOINT_FILE = 'serve-endpoint.json';

function tmpReconDir(): string {
  return mkdtempSync(join(tmpdir(), 'recon-endpoint-'));
}

/**
 * A deterministic dead pid: spawnSync blocks until the child exits AND reaps it, so
 * by the time it returns the pid is no longer a live process. (The OS does not reuse
 * a freshly-freed pid for the duration of a unit test.)
 */
function deadPid(): number {
  const reaped = spawnSync(process.execPath, ['-e', '0']);
  return reaped.pid!;
}

function miniGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode({
    id: 'ts:func:warm', type: NodeType.Function, name: 'warm', file: 'src/warm.ts',
    startLine: 1, endLine: 2, language: Language.TypeScript, package: 'src', exported: true,
  });
  return g;
}

describe('discovery file helpers — the {pid,port} cross-repo contract (recon-brain-recall-02)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('round-trips {pid,port} for a live pid', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: process.pid, port: 51234 });
    expect(readEndpoint(dir)).toEqual({ pid: process.pid, port: 51234 });
  });

  it('returns null (not warm) when the file is absent', () => {
    dir = tmpReconDir();
    expect(readEndpoint(dir)).toBeNull();
  });

  it('returns null (not warm) for malformed JSON', () => {
    dir = tmpReconDir();
    writeFileSync(join(dir, ENDPOINT_FILE), '{ not json', 'utf-8');
    expect(readEndpoint(dir)).toBeNull();
  });

  it('returns null (not warm) for valid JSON with the wrong shape', () => {
    dir = tmpReconDir();
    writeFileSync(join(dir, ENDPOINT_FILE), JSON.stringify({ pid: 'x', port: 1 }), 'utf-8');
    expect(readEndpoint(dir)).toBeNull();
  });

  it('returns null (not warm) when the announced pid is dead', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: deadPid(), port: 51234 });
    expect(readEndpoint(dir)).toBeNull();
  });

  it('removeEndpoint deletes the file and is a no-op when already absent', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: process.pid, port: 1 });
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(true);
    removeEndpoint(dir);
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(false);
    expect(() => removeEndpoint(dir)).not.toThrow();
  });
});

describe('query-door orchestration gate (recon-brain-recall-02)', () => {
  let dir: string;
  let door: QueryDoorHandle | null = null;
  afterEach(() => {
    if (door) { door.close(); door = null; }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('gate ON: binds 127.0.0.1 on an OS-assigned port, announces the real {pid,port}, and answers', async () => {
    dir = tmpReconDir();
    door = await maybeStartQueryDoor({ serveHttp: true, reconDir: dir, graph: miniGraph() });

    expect(door).not.toBeNull();
    expect(typeof door!.port).toBe('number');
    expect(door!.port).toBeGreaterThan(0);

    // the discovery file announces THIS process + the REAL assigned port, and the
    // reader resolves it (pid is alive) — the writer↔reader contract end to end.
    expect(readEndpoint(dir)).toEqual({ pid: process.pid, port: door!.port });

    // the door is reachable on loopback and is the recon find app (read-only)
    const res = await fetch(`http://127.0.0.1:${door!.port}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');

    // best-effort shutdown cleanup removes the discovery file
    door.close();
    door = null;
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(false);
  });

  it('gate OFF (default): no bind, no endpoint file — serve behavior unchanged', async () => {
    dir = tmpReconDir();
    door = await maybeStartQueryDoor({ serveHttp: false, reconDir: dir, graph: miniGraph() });
    expect(door).toBeNull();
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(false);
  });
});

describe('serveHttp config gate (recon-brain-recall-02)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('defaults OFF when there is no .recon-wrxn.json', () => {
    dir = tmpReconDir();
    expect(loadConfig(dir).serveHttp).toBe(false);
  });

  it('initConfig seeds serveHttp:false into the template', () => {
    dir = tmpReconDir();
    initConfig(dir);
    expect(loadConfig(dir).serveHttp).toBe(false);
  });
});

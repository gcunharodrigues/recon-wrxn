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
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  writeEndpoint,
  removeEndpoint,
  readEndpoint,
  claimEndpoint,
  maybeStartQueryDoor,
  startQueryDoorSafe,
} from '../../src/server/endpoint.js';
import type { QueryDoorHandle } from '../../src/server/endpoint.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import { loadConfig, initConfig } from '../../src/config/config.js';
import { serveNeedsReindex } from '../../src/analyzers/tree-sitter/carryover.js';

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

  it('writes the endpoint file owner-only (0600) — no group/other read bits (review #4)', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: process.pid, port: 51234 });
    const mode = statSync(join(dir, ENDPOINT_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
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

/**
 * Lifecycle race self-heal (recon-wrxn#4). Multiple `serve` processes share ONE
 * discovery file. The fix makes ownership cooperative WITHOUT changing the file
 * path/name/{pid,port} shape: removeEndpoint is pid-guarded (only the owner deletes)
 * and claimEndpoint claims the file only when it is free (absent / dead-pid owner).
 * The liveness probe is injectable so the death-order scenario is deterministic —
 * no real processes, no real timers.
 */
describe('cooperative ownership — pid-guarded remove + claim-if-free (recon-wrxn#4)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const onDisk = (d: string) =>
    JSON.parse(readFileSync(join(d, ENDPOINT_FILE), 'utf-8')) as { pid: number; port: number };

  it('removeEndpoint leaves a file owned by a DIFFERENT pid untouched (AC-1)', () => {
    dir = tmpReconDir();
    const foreignPid = process.pid + 1;
    writeEndpoint(dir, { pid: foreignPid, port: 51000 });
    removeEndpoint(dir);
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(true);
    expect(onDisk(dir)).toEqual({ pid: foreignPid, port: 51000 });
  });

  // claimEndpoint takes an injectable liveness probe so these are deterministic.
  const allDead = (_pid: number) => false;
  const allAlive = (_pid: number) => true;

  it('claimEndpoint writes {pid,port} when the file is ABSENT (AC-2)', () => {
    dir = tmpReconDir();
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(false);
    claimEndpoint(dir, { pid: 4242, port: 51001 }, allAlive);
    expect(onDisk(dir)).toEqual({ pid: 4242, port: 51001 });
  });

  it('claimEndpoint takes over a file whose owner pid is DEAD (AC-2)', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: 9999, port: 51002 }); // a stale owner
    claimEndpoint(dir, { pid: 4242, port: 51003 }, allDead); // probe: 9999 is dead
    expect(onDisk(dir)).toEqual({ pid: 4242, port: 51003 });
  });

  it('claimEndpoint is a NO-OP when the file points to a LIVE different pid (AC-2)', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: 8888, port: 51004 }); // a live foreign owner
    claimEndpoint(dir, { pid: 4242, port: 51005 }, allAlive); // probe: 8888 is alive
    expect(onDisk(dir)).toEqual({ pid: 8888, port: 51004 }); // untouched
  });

  it('claimEndpoint is a NO-OP when the file already points to THIS live pid — no churn (AC-2)', () => {
    dir = tmpReconDir();
    writeEndpoint(dir, { pid: 4242, port: 51006 });
    // Same live pid, DIFFERENT port: a live owner's file (incl. our own) is left as-is,
    // so the heartbeat does NOT rewrite the file every tick. The distinct port would only
    // land on disk if claim wrongly overwrote a self-owned live file.
    claimEndpoint(dir, { pid: 4242, port: 59999 }, allAlive);
    expect(onDisk(dir)).toEqual({ pid: 4242, port: 51006 }); // unchanged → proven no-op
  });

  /**
   * The full death-order race (recon-wrxn#4), driven purely through the public
   * helpers with an injectable liveness probe + a manual "heartbeat tick" — no real
   * processes, no real timers. Survivor B must end up owning a file pointing at its
   * OWN live {pid,port}, even though announcer A dies and runs its remove last.
   */
  it('death-order resolves to the SURVIVOR via claim-heartbeat + pid-guarded remove (AC-3)', () => {
    dir = tmpReconDir();
    const A = { pid: 100, port: 50100 };
    const B = { pid: 200, port: 50200 };
    const liveset = new Set<number>([A.pid, B.pid]);
    const alive = (pid: number) => liveset.has(pid);

    // 1. Serve A starts, claims the free file → A owns it.
    claimEndpoint(dir, A, alive);
    expect(onDisk(dir)).toEqual(A);

    // 2. Serve B starts; A is still live → B's startup claim is a no-op. A still owns.
    claimEndpoint(dir, B, alive);
    expect(onDisk(dir)).toEqual(A);

    // 3. Serve A dies. With the OLD unconditional rmSync its exit deleted the file
    //    out from under the still-serving B; with the pid-guard, A's death just frees
    //    ownership. Simulate A's exit cleanup running (in A's process, pid===A.pid).
    liveset.delete(A.pid);

    // 4. B's heartbeat tick fires: the on-disk owner (A) is now dead → B re-claims.
    claimEndpoint(dir, B, alive);
    expect(onDisk(dir)).toEqual(B);

    // 5. A's late remove (a stale closer firing after B re-claimed) sees a foreign
    //    pid on disk and leaves B's file intact — readers still find the live door.
    //    (removeEndpoint guards on process.pid; the on-disk pid is B's, not ours.)
    removeEndpoint(dir);
    expect(existsSync(join(dir, ENDPOINT_FILE))).toBe(true);
    expect(onDisk(dir)).toEqual(B);
    expect(readEndpoint(dir, alive)).toEqual(B); // resolves to the live survivor
  });
});

// ─── Serve-startup self-heal of a degenerate loaded index (C2, [#10]) ────────
//
// The serve-startup gate currently auto-indexes ONLY when no index exists or the
// commit moved (stale). A LOADED index that is degenerate — zero tree-sitter
// symbols while code files are present — passes the gate and is served dark,
// which keeps an install empty across every restart. serveNeedsReindex extends
// the startup decision to also fire on a degenerate loaded index, REUSING C1's
// detection (shouldReactiveHeal) — no second detector. The decision is the seam:
// the served-graph-has-symbols>0 outcome follows from indexCommand's own heal,
// already proven end-to-end by the index self-heal suite ([#8]).

describe('serve-startup self-heal: degenerate loaded index triggers reindex ([#10])', () => {
  const TS = [Language.TypeScript];

  /** A graph with `n` tree-sitter (TypeScript) symbols. */
  function graphWithSymbols(n: number): KnowledgeGraph {
    const g = new KnowledgeGraph();
    for (let i = 0; i < n; i++) {
      g.addNode({
        id: `ts:func:fn${i}`, type: NodeType.Function, name: `fn${i}`, file: `src/mod${i}.ts`,
        startLine: 1, endLine: 2, language: Language.TypeScript, package: 'src', exported: true,
      });
    }
    return g;
  }

  /** fileHashes for `n` code files (the "code present" signal serve reads). */
  function codeHashes(n: number): Record<string, string> {
    const h: Record<string, string> = {};
    for (let i = 0; i < n; i++) h[`src/mod${i}.ts`] = `hash${i}`;
    return h;
  }

  it('a degenerate loaded index (zero symbols, code present, same commit) → reindex', () => {
    // The exact sticky-dark state: hashes recorded for code files, but the loaded
    // graph holds zero tree-sitter symbols, and the commit has NOT moved (so the
    // pre-C2 staleness gate would have served it as-is).
    expect(
      serveNeedsReindex({
        existingGraph: graphWithSymbols(0), // degenerate: zero symbols
        fileHashes: codeHashes(5),          // but 5 code files are present
        indexedCommit: 'abc123',
        currentCommit: 'abc123',            // same commit → not "stale"
        tsitterLangs: TS,
      }),
    ).toBe(true);
  });

  it('a HEALTHY loaded index (symbols present, same commit) → no reindex (no startup-cost regression)', () => {
    expect(
      serveNeedsReindex({
        existingGraph: graphWithSymbols(5), // populated graph
        fileHashes: codeHashes(5),
        indexedCommit: 'abc123',
        currentCommit: 'abc123',
        tsitterLangs: TS,
      }),
    ).toBe(false);
  });

  it('a DOCS-ONLY index (zero symbols, ZERO code files) → no reindex (docs-only stays zero, never heals)', () => {
    // Zero tree-sitter symbols is LEGITIMATE here — there are no code-typed files in
    // fileHashes, only prose. shouldReactiveHeal must not fire (codeFilesPresent=0).
    expect(
      serveNeedsReindex({
        existingGraph: graphWithSymbols(0),
        fileHashes: { 'README.md': 'h', 'docs/guide.md': 'h2' }, // prose only
        indexedCommit: 'abc123',
        currentCommit: 'abc123',
        tsitterLangs: TS,
      }),
    ).toBe(false);
  });

  it('no index loaded (absent) → reindex (preserves the prior "no index found" path)', () => {
    expect(
      serveNeedsReindex({
        existingGraph: null,
        fileHashes: {},
        indexedCommit: null,
        currentCommit: 'abc123',
        tsitterLangs: TS,
      }),
    ).toBe(true);
  });

  it('a STALE loaded index (commit moved) → reindex even when populated (preserves prior staleness)', () => {
    expect(
      serveNeedsReindex({
        existingGraph: graphWithSymbols(5), // populated, but…
        fileHashes: codeHashes(5),
        indexedCommit: 'old111',
        currentCommit: 'new222',            // …commit moved → stale
        tsitterLangs: TS,
      }),
    ).toBe(true);
  });
});

// ─── End-to-end: serve startup actually heals + serves symbols ([#10]) ────────
//
// The decision block above proves serveNeedsReindex; this proves serveCommand WIRES
// it. Drive the REAL `serve` binary against a persisted degenerate index (the exact
// sticky-dark state, seeded the C1 way: a correct --force index with the code symbols
// surgically stripped from graph.json, fileHashes left intact). serve must auto-index
// on startup and persist a healed graph; we poll graph.json for symbols, then kill the
// (otherwise-blocking) stdio server. Subprocess pattern mirrors the index self-heal
// suite — worker_threads inside vitest's own pool hangs, a fresh node process does not.

describe('serve startup self-heals a degenerate persisted index end-to-end ([#10])', () => {
  const RECON_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/recon-wrxn');
  const dirs: string[] = [];
  const procs: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const reconDir = (root: string) => join(root, '.recon-wrxn');
  const readGraph = (root: string) =>
    JSON.parse(readFileSync(join(reconDir(root), 'graph.json'), 'utf-8'));
  const tsSymbolCount = (root: string): number =>
    readGraph(root).nodes.filter((n: { language: string }) => n.language === 'typescript').length;

  const index = (root: string, args: string[] = []) =>
    execFileSync('node', [RECON_BIN, 'index', ...args, '--no-embeddings'], {
      cwd: root, stdio: 'pipe', encoding: 'utf-8',
    });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('starting serve against a sticky-empty (degenerate) index recovers symbols > 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-serve-heal-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(root, 'src', `mod${i}.ts`), `export function fn${i}(x: number) {\n  return x + ${i};\n}\n`);
    }

    // Seed the degenerate index: a correct --force index, then strip ALL typescript
    // symbols from graph.json while leaving meta.json (with fileHashes) intact.
    index(root, ['--force']);
    const g = readGraph(root);
    g.nodes = g.nodes.filter((n: { language: string }) => n.language !== 'typescript');
    g.relationships = [];
    writeFileSync(join(reconDir(root), 'graph.json'), JSON.stringify(g, null, 2));
    expect(tsSymbolCount(root)).toBe(0); // precondition: sticky-empty

    // Start the REAL serve (stdio). --no-watch/--no-serve-embed keep it minimal; it
    // auto-indexes on startup BEFORE blocking on stdio, persisting the healed graph.
    const proc = spawn('node', [RECON_BIN, 'serve', '--no-watch', '--no-serve-embed'], {
      cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
    });
    procs.push(proc);

    // Poll the persisted graph until the startup heal lands symbols (or time out).
    let healed = 0;
    for (let i = 0; i < 60 && healed === 0; i++) {
      await sleep(500);
      try { healed = tsSymbolCount(root); } catch { /* graph mid-rewrite */ }
    }

    expect(healed).toBeGreaterThan(0); // serve startup reindexed the degenerate index
  }, 60_000);
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
    door!.close();
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

describe('startQueryDoorSafe — door is fail-open (recon-brain-recall-review #3)', () => {
  const opts = { serveHttp: true, reconDir: '/x', graph: miniGraph() };

  it('returns null (never throws) when the door starter REJECTS — stdio can still start', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => { throw new Error('EADDRINUSE bind failed'); });

    const handle = await startQueryDoorSafe(opts, boom);

    expect(handle).toBeNull();
    expect(boom).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled(); // a warning was logged to stderr
    errSpy.mockRestore();
  });

  it('returns null when the starter throws SYNCHRONOUSLY', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(() => { throw new Error('sync FS error'); });

    const handle = await startQueryDoorSafe(opts, boom as unknown as typeof maybeStartQueryDoor);

    expect(handle).toBeNull();
    errSpy.mockRestore();
  });

  it('passes the real handle through on success', async () => {
    const fake = { port: 4321, close: vi.fn() };
    const handle = await startQueryDoorSafe(opts, async () => fake);
    expect(handle).toBe(fake);
  });
});

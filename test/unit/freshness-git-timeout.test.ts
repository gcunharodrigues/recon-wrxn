/**
 * Unit Test: freshness git shell-outs are time/size bounded ([#9] D1)
 *
 * computeFreshness shells out to git on EVERY find/explain/impact answer. A pathological
 * repo (huge worktree, slow/network FS, index.lock contention, a hung git) must not block
 * the answer — the AC says computing the count "does not block the answer". So each git
 * call must carry a finite `timeout` (on which execFileSync throws → the helper's catch
 * already degrades to UNKNOWN) plus an explicit `maxBuffer` ceiling.
 *
 * Seam: a boundary spy on node:child_process.execFileSync that WRAPS (calls through to)
 * real git, so the real freshness flow runs end to end; we only inspect the options each
 * git shell-out receives — no behavioral stub, no coupling to call order/count.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: readonly string[]; opts: Record<string, unknown> }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((cmd: string, args: readonly string[], opts?: Record<string, unknown>) => {
      calls.push({ cmd, args, opts: opts ?? {} });
      return (actual.execFileSync as (...a: unknown[]) => unknown)(cmd, args, opts);
    }) as typeof actual.execFileSync,
  };
});

import { execFileSync } from 'node:child_process';
import { computeFreshness } from '../../src/mcp/freshness.js';

function runGit(cwd: string, ...args: string[]): string {
  return (execFileSync('git', args, { cwd, encoding: 'utf-8' }) as string).trim();
}

describe('[#9] computeFreshness — git shell-outs are bounded (timeout + maxBuffer)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('every git call carries a finite timeout and an explicit maxBuffer (per-answer DoS bound)', () => {
    dir = mkdtempSync(join(tmpdir(), 'recon-fresh-timeout-'));
    runGit(dir, 'init', '-q');
    runGit(dir, 'config', 'user.email', 'test@example.com');
    runGit(dir, 'config', 'user.name', 'Test');
    runGit(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    runGit(dir, 'add', '-A');
    runGit(dir, 'commit', '-q', '-m', 'init');
    const indexed = runGit(dir, 'rev-parse', '--short', 'HEAD');

    calls.length = 0; // ignore the setup calls; inspect only the SUT's git shell-outs

    const f = computeFreshness({ projectRoot: dir, indexedCommit: indexed });
    expect(f.dirty).toBe(0); // sanity: the real git path actually ran (not a vacuous pass)

    const gitCalls = calls.filter((c) => c.cmd === 'git');
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const c of gitCalls) {
      const timeout = c.opts.timeout;
      const maxBuffer = c.opts.maxBuffer;
      expect(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0).toBe(true);
      expect(typeof maxBuffer === 'number' && Number.isFinite(maxBuffer) && maxBuffer > 0).toBe(true);
    }
  });
});

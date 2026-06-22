/**
 * Unit Tests: live watcher-delta dirty set in serve ([#11] D2)
 *
 * D2 upgrades D1's per-answer git dirty COUNT into a live watcher-maintained SET in serve:
 *   - at serve startup the set is SEEDED from git (the same D1 computation) so an offline
 *     change made while serve was down is visible before any new edit; then
 *   - the watcher MAINTAINS it live — it ADDS a file when it observes a change event and
 *     REMOVES it once that file is successfully re-parsed.
 * The serve footer reads this set's size (normally near-zero) so it reflects the live
 * served graph, not the persisted index. The cold CLI path (no watcher) is unchanged — it
 * still computes the count on demand from git (computeFreshness, [#9] D1).
 *
 * Primary seam: `watcher-source` — the ReconWatcher subsystem + the freshness seed, driven
 * over a REAL temp git repo exactly as the manual reproduction would. handleFileEvent is the
 * raw observation; processFile is the re-parse (the same processFile cast watcher-source.test.ts
 * uses). Kept in its own file so the git-repo setup does not entangle the source-fixture beforeEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReconWatcher } from '../../src/watcher/watcher.js';
import { seedDirtySet } from '../../src/mcp/freshness.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recon-d2-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

// Drive the watcher's two private lifecycle seams directly (as watcher-source.test.ts does
// for processFile): handleFileEvent is the raw observation (increment), processFile the re-parse.
function observe(w: ReconWatcher, abs: string, event: 'add' | 'change' | 'unlink'): void {
  (w as unknown as { handleFileEvent(p: string, e: string): void }).handleFileEvent(abs, event);
}
function reparse(w: ReconWatcher, abs: string, event: 'add' | 'change' | 'unlink'): Promise<void> {
  return (w as unknown as { processFile(a: string, r: string, e: string): Promise<void> })
    .processFile(abs, 'proj', event);
}

let root: string;
let watcher: ReconWatcher | undefined;

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('[#11] live watcher-delta dirty set — seed then maintain', () => {
  it('seeds offline changes at startup, increments on an observed edit, decrements on re-parse', async () => {
    // ── seed: a repo indexed at a commit, then an OFFLINE change made while serve was down ──
    root = initRepo();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    const indexedCommit = git(root, 'rev-parse', '--short', 'HEAD');

    // offline edit (uncommitted) to a.ts — happened while serve was down
    writeFileSync(join(root, 'src', 'a.ts'), 'export function a() { return 2; }\n');

    const dirtySet = seedDirtySet({ projectRoot: root, indexedCommit });
    // AC: the offline change is present in the count at STARTUP, before any live edit
    expect(dirtySet.has('src/a.ts')).toBe(true);
    expect(dirtySet.size).toBe(1);

    // ── maintain: the watcher holds the SAME set and keeps it live ──
    const graph = new KnowledgeGraph();
    watcher = new ReconWatcher(
      graph,
      [{ dir: root, repoName: 'proj' }],
      100_000, // huge debounce: the observe timer never fires during the test; stop() clears it
      [],
      root,
      Infinity,
      undefined,
      undefined,
      dirtySet,
    );

    // a NEW file edit observed by the watcher → dirty count INCREMENTS
    writeFileSync(join(root, 'src', 'b.ts'), 'export function b() { return 1; }\n');
    observe(watcher, join(root, 'src', 'b.ts'), 'add');
    expect(dirtySet.has('src/b.ts')).toBe(true);
    expect(dirtySet.size).toBe(2);

    // once that file is successfully re-parsed → dirty count DECREMENTS back down
    await reparse(watcher, join(root, 'src', 'b.ts'), 'add');
    expect(dirtySet.has('src/b.ts')).toBe(false);
    // steady state reflects the live served graph: b.ts absorbed, only the still-pending
    // offline a.ts remains — NOT the persisted index's view.
    expect(dirtySet.size).toBe(1);
  });
});

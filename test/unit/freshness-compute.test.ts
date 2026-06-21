/**
 * Unit Tests: computeFreshness — the git dirty-count + watermark ([#9] D1)
 *
 * The freshness module computes the dirty count at ANSWER TIME from git:
 *   dirty = (files changed since the indexed commit) ∪ (uncommitted / untracked).
 * It exposes the watermark (commit, dirty) the formatter consumes as an injected input.
 * A non-git project degrades gracefully (commit `none`, dirty `unknown`, no crash) and
 * computing the count performs no re-index (it never touches the graph/index — only git).
 *
 * These run against REAL temp git repos (and a non-git temp dir) so the git seam is
 * exercised end to end, not stubbed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFreshness } from '../../src/mcp/freshness.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recon-fresh-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commitAll(dir: string, msg: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

describe('[#9] computeFreshness — git dirty count', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('a clean tree at the indexed commit → dirty 0, commit = indexed short commit', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const indexed = commitAll(dir, 'init');

    const f = computeFreshness({ projectRoot: dir, indexedCommit: indexed });
    expect(f.commit).toBe(indexed);
    expect(f.dirty).toBe(0);
  });

  it('counts files changed since the indexed commit (a later commit) PLUS uncommitted', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const indexed = commitAll(dir, 'init');

    // 1) a file changed in a LATER commit (committed since the indexed commit)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    commitAll(dir, 'change a');
    // 2) an uncommitted modification to a tracked file
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n');
    // 3) an untracked new file
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');

    const f = computeFreshness({ projectRoot: dir, indexedCommit: indexed });
    expect(f.commit).toBe(indexed);
    // union of {a.ts (changed vs indexed), b.ts (untracked)} = 2
    expect(f.dirty).toBe(2);
  });

  it('does not double-count a file that is both committed-since and further modified', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const indexed = commitAll(dir, 'init');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    commitAll(dir, 'change a');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n'); // also uncommitted

    const f = computeFreshness({ projectRoot: dir, indexedCommit: indexed });
    expect(f.dirty).toBe(1); // a.ts counted once
  });

  it('a staged but uncommitted file is counted', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const indexed = commitAll(dir, 'init');
    writeFileSync(join(dir, 'c.ts'), 'export const c = 1;\n');
    git(dir, 'add', 'c.ts');

    const f = computeFreshness({ projectRoot: dir, indexedCommit: indexed });
    expect(f.dirty).toBe(1);
  });
});

describe('[#9] computeFreshness — non-git + degenerate inputs', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('a non-git project → commit `none`, dirty `unknown`, no crash', () => {
    dir = mkdtempSync(join(tmpdir(), 'recon-nongit-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    const f = computeFreshness({ projectRoot: dir, indexedCommit: 'deadbee' });
    expect(f.commit).toBe('none');
    expect(f.dirty).toBe('unknown');
  });

  it('a null/absent indexed commit → commit `none`, dirty `unknown` (no comparison base)', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    commitAll(dir, 'init');

    const f = computeFreshness({ projectRoot: dir, indexedCommit: null });
    expect(f.commit).toBe('none');
    expect(f.dirty).toBe('unknown');
  });

  it('an indexed commit that is not in the repo → dirty `unknown`, no crash (graceful)', () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    commitAll(dir, 'init');

    const f = computeFreshness({ projectRoot: dir, indexedCommit: 'deadbeef' });
    expect(f.dirty).toBe('unknown');
  });
});

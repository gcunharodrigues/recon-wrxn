/**
 * Unit Tests: reviewer git shell-injection hardening (recon-brain-recall-review #2)
 *
 * recon_changes built `git diff ${base}...HEAD` strings and ran them via execSync
 * (a shell) — `base` is attacker-controlled ⇒ command injection. The fix: run git
 * via execFileSync (argv array, NO shell) and reject any caller-supplied ref that
 * is not `^[A-Za-z0-9._/-]+$`.
 *
 * node:child_process is mocked so we can assert the argv form WITHOUT a real repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => ''),
  };
});

import { execFileSync, execSync } from 'node:child_process';
import { analyzeChanges, assertSafeGitRef } from '../../src/review/reviewer.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';

describe('assertSafeGitRef (recon-brain-recall-review #2)', () => {
  it('accepts plain refs', () => {
    expect(() => assertSafeGitRef('main')).not.toThrow();
    expect(() => assertSafeGitRef('origin/main')).not.toThrow();
    expect(() => assertSafeGitRef('release-1.2.3')).not.toThrow();
    expect(() => assertSafeGitRef('feature/foo-bar')).not.toThrow();
    expect(() => assertSafeGitRef('HEAD')).not.toThrow();
  });

  it('rejects shell metacharacters', () => {
    expect(() => assertSafeGitRef('main;id')).toThrow();
    expect(() => assertSafeGitRef('$(id)')).toThrow();
    expect(() => assertSafeGitRef('main && rm -rf /')).toThrow();
    expect(() => assertSafeGitRef('`id`')).toThrow();
    expect(() => assertSafeGitRef('main | cat')).toThrow();
    expect(() => assertSafeGitRef('')).toThrow();
  });

  // The allowlist is defense-in-depth (execFileSync = no shell), so it should not
  // reject legitimate git revision syntax (recon-brain-recall-review #2 widening).
  it('accepts git revision syntax, underscores and @{...}', () => {
    expect(() => assertSafeGitRef('HEAD~1')).not.toThrow();
    expect(() => assertSafeGitRef('HEAD^')).not.toThrow();
    expect(() => assertSafeGitRef('@{u}')).not.toThrow();
    expect(() => assertSafeGitRef('origin/feature_branch')).not.toThrow();
    expect(() => assertSafeGitRef('release/1.2.3')).not.toThrow();
  });

  it('still rejects shell metacharacters and whitespace after widening', () => {
    expect(() => assertSafeGitRef('main;id')).toThrow();
    expect(() => assertSafeGitRef('$(x)')).toThrow();
    expect(() => assertSafeGitRef('a b')).toThrow();
    expect(() => assertSafeGitRef('a|b')).toThrow();
    expect(() => assertSafeGitRef('`x`')).toThrow();
    expect(() => assertSafeGitRef('')).toThrow();
  });
});

describe('analyzeChanges git invocation (recon-brain-recall-review #2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs git via execFileSync with an argv array — never a shell (execSync)', () => {
    analyzeChanges(new KnowledgeGraph(), '/tmp', { scope: 'branch', base: 'origin/main' });

    expect(execSync).not.toHaveBeenCalled();
    const calls = (execFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [bin, argv] of calls) {
      expect(bin).toBe('git');
      expect(Array.isArray(argv)).toBe(true);
    }
    // the ref lands as ONE argv element (`origin/main...HEAD`), not interpolated text
    const argvs = calls.map(c => c[1] as string[]);
    expect(argvs.some(a => a.includes('origin/main...HEAD'))).toBe(true);
  });

  it('rejects an injection base BEFORE any git process runs', () => {
    expect(() =>
      analyzeChanges(new KnowledgeGraph(), '/tmp', { scope: 'branch', base: 'main;id' }),
    ).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });
});

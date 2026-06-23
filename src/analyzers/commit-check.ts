/**
 * Git-backed commit-existence checker (citation-recon R3 fold, #20).
 *
 * The evidence resolver (evidence-edges.ts) tags an EVIDENCED_BY commit watermark
 * `commitResolved` only when the sha actually EXISTS in history — but it stays PURE
 * (no git IO) by accepting an INJECTED `CommitExists`. This module is that injection:
 * a tiny git-backed factory both index call sites build from their repo dir — the
 * cold CLI index (commands.ts ingestProse) and the live watcher reload (watcher.ts) —
 * so live-edited pages get the same in-history honesty as a full re-index. Kept here
 * (not in evidence-edges.ts) to preserve the resolver's purity, and in its own module
 * (not commands.ts) because commands.ts imports the watcher, which would cycle.
 */

import { execFileSync } from 'node:child_process';
import type { CommitExists } from './evidence-edges.js';

/**
 * Build a commit-existence checker bound to a repo dir. The resolver only ever passes
 * a syntactically valid sha (SHA_RE), so the value is safe to hand git; `^{commit}`
 * requires it resolve to a real commit object (not just any object). Fail-soft: any
 * git failure / outside a repo → false (the resolver then treats the commit as
 * inferred). Bounded (timeout) like the freshness shell-outs so a hung git — huge
 * worktree, index.lock contention — never blocks indexing.
 */
export function makeCommitExists(cwd: string): CommitExists {
  return (sha: string): boolean => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
        cwd,
        stdio: 'ignore',
        timeout: 2000,
      });
      return true;
    } catch {
      return false;
    }
  };
}

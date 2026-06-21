/**
 * Freshness watermark ([#9] D1)
 *
 * Every code-intelligence answer states how fresh the graph is. This module is the
 * single place that (a) computes the dirty count + watermark via git, and (b) renders
 * the footer + scoped absence warning. The answer-formatting layer (handlers /
 * http-*-structured) consumes the resulting `Freshness` as an INJECTED input and never
 * computes it inline — the git work lives here, behind a testable seam, and is computed
 * at answer time (so it works in serve and on the cold CLI path).
 */

import { execFileSync } from 'node:child_process';

/**
 * The freshness watermark injected into answer formatting. `commit` is the indexed
 * short commit (or `none` outside a git repo); `dirty` is the live count of files
 * changed since the indexed commit plus uncommitted, or `'unknown'` outside a git repo.
 */
export interface Freshness {
  commit: string;
  dirty: number | 'unknown';
}

/** A non-git / uncomparable watermark: the graceful-degradation shape. */
const UNKNOWN: Freshness = { commit: 'none', dirty: 'unknown' };

/** Run a git command, returning trimmed stdout, or `null` if git fails/errors. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Bound this answer-time shell-out: a hung/slow git (huge worktree, network FS,
      // index.lock contention) must not block the answer — on timeout execFileSync throws
      // and the catch below degrades to `null`/UNKNOWN. The explicit 16 MiB ceiling caps
      // memory for the file-list output (vs. the 1 MB default) before it would ENOBUFS.
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Compute the freshness watermark at ANSWER TIME. The dirty count is the union of:
 *   - tracked files differing from the indexed commit (`git diff --name-only <commit>`:
 *     covers committed-since-indexed, staged, AND unstaged modifications), and
 *   - untracked new files (`git ls-files --others --exclude-standard`).
 *
 * This is a pure git read — it NEVER re-indexes or touches the graph, and a single
 * synchronous shell-out does not block the answer. Degrades gracefully: a non-git
 * project, an absent indexed commit, or an indexed commit not present in the repo all
 * yield a `dirty: 'unknown'` watermark rather than crashing.
 */
export function computeFreshness(
  opts: { projectRoot: string; indexedCommit: string | null | undefined },
): Freshness {
  const { projectRoot, indexedCommit } = opts;

  // No comparison base, or a value that is not a plain git sha → degrade immediately,
  // BEFORE any git shell-out and before the value can reach the footer. `indexedCommit`
  // is an unvalidated string from the persisted index; a crafted one (flag-leading like
  // `--output=…`, space-smuggled, or multi-line) must never flow to a git arg nor be
  // echoed into the markdown footer an LLM agent consumes. Real short/full SHAs are hex.
  if (!indexedCommit || !/^[0-9a-fA-F]{4,40}$/.test(indexedCommit)) return UNKNOWN;

  // Not a git work tree → graceful degradation.
  if (git(projectRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return UNKNOWN;
  }

  // The indexed commit must exist in this repo to compare against it.
  if (git(projectRoot, ['cat-file', '-e', `${indexedCommit}^{commit}`]) === null) {
    return { commit: indexedCommit, dirty: 'unknown' };
  }

  const changed = git(projectRoot, ['diff', '--name-only', indexedCommit]);
  const untracked = git(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  if (changed === null || untracked === null) {
    return { commit: indexedCommit, dirty: 'unknown' };
  }

  const files = new Set<string>();
  for (const line of `${changed}\n${untracked}`.split('\n')) {
    const f = line.trim();
    if (f) files.add(f);
  }

  return { commit: indexedCommit, dirty: files.size };
}

/**
 * Render the one-line freshness footer: `indexed @ <commit>, N files dirty`.
 * Pure — it only formats an already-computed watermark.
 */
export function formatFreshnessFooter(f: Freshness): string {
  return `indexed @ ${f.commit}, ${f.dirty} files dirty`;
}

/**
 * Append the freshness footer to an answer, plus — only when the answer is an ABSENCE
 * (find no results, impact no callers/dependents) AND the working tree is dirty (N > 0)
 * — an explicit "verify before acting on this absence" warning. Pure: it consumes the
 * injected watermark and never shells out.
 */
export function appendFreshness(
  text: string,
  f: Freshness,
  opts: { absence: boolean },
): string {
  const footer = formatFreshnessFooter(f);
  const dirtyCount = typeof f.dirty === 'number' ? f.dirty : 0;
  const lines = [text, '', '---', footer];
  if (opts.absence && dirtyCount > 0) {
    lines.push(
      `\n> WARNING: the working tree has uncommitted/unindexed changes — verify before acting on this absence (the graph may be stale).`,
    );
  }
  return lines.join('\n');
}

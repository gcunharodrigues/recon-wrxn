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
 * The git dirty computation shared by the cold-path COUNT (computeFreshness) and the serve
 * live-set SEED (seedDirtySet, [#11] D2). The dirty set is the union of:
 *   - tracked files differing from the indexed commit (`git diff --name-only <commit>`:
 *     covers committed-since-indexed, staged, AND unstaged modifications), and
 *   - untracked new files (`git ls-files --others --exclude-standard`).
 *
 * A pure git read — it NEVER re-indexes or touches the graph, and the synchronous shell-outs
 * are bounded (see `git`). Returns a discriminated result so each caller maps the
 * degeneracies to its own shape:
 *   - `none`         — no/invalid indexed commit OR not a git work tree (→ commit `none`).
 *   - `uncomparable` — the indexed commit is absent from the repo, or a git read failed.
 *   - `ok`           — the comparable dirty file set (relative, git-root paths).
 */
type DirtyResult =
  | { kind: 'none' }
  | { kind: 'uncomparable' }
  | { kind: 'ok'; files: Set<string> };

function gitDirty(projectRoot: string, indexedCommit: string | null | undefined): DirtyResult {
  // No comparison base, or a value that is not a plain git sha → degrade immediately,
  // BEFORE any git shell-out and before the value can reach the footer. `indexedCommit`
  // is an unvalidated string from the persisted index; a crafted one (flag-leading like
  // `--output=…`, space-smuggled, or multi-line) must never flow to a git arg nor be
  // echoed into the markdown footer an LLM agent consumes. Real short/full SHAs are hex.
  if (!indexedCommit || !/^[0-9a-fA-F]{4,40}$/.test(indexedCommit)) return { kind: 'none' };

  // Not a git work tree → graceful degradation.
  if (git(projectRoot, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return { kind: 'none' };
  }

  // The indexed commit must exist in this repo to compare against it.
  if (git(projectRoot, ['cat-file', '-e', `${indexedCommit}^{commit}`]) === null) {
    return { kind: 'uncomparable' };
  }

  const changed = git(projectRoot, ['diff', '--name-only', indexedCommit]);
  const untracked = git(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  if (changed === null || untracked === null) {
    return { kind: 'uncomparable' };
  }

  const files = new Set<string>();
  for (const line of `${changed}\n${untracked}`.split('\n')) {
    const f = line.trim();
    if (f) files.add(f);
  }
  return { kind: 'ok', files };
}

/**
 * Compute the freshness watermark at ANSWER TIME — the COLD CLI path (no live watcher).
 * The dirty count is the size of the git dirty set computed on demand. Degrades gracefully:
 * a non-git project, an absent indexed commit, or an indexed commit not present in the repo
 * all yield a `dirty: 'unknown'` watermark rather than crashing. A single synchronous git
 * read never re-indexes and does not block the answer. (In serve the watcher maintains a live
 * set instead, seeded from this same computation — see seedDirtySet / serveFreshness.)
 */
export function computeFreshness(
  opts: { projectRoot: string; indexedCommit: string | null | undefined },
): Freshness {
  const { projectRoot, indexedCommit } = opts;
  const r = gitDirty(projectRoot, indexedCommit);
  // `none` → the fully-unknown watermark; for `uncomparable`/`ok` the commit is a validated
  // sha (gitDirty returns `none` for every falsy/non-sha case), so `indexedCommit!` is real.
  if (r.kind === 'none') return UNKNOWN;
  if (r.kind === 'uncomparable') return { commit: indexedCommit!, dirty: 'unknown' };
  return { commit: indexedCommit!, dirty: r.files.size };
}

/**
 * Seed the SERVE live dirty set at startup ([#11] D2). REUSES the exact git computation
 * D1's computeFreshness performs (gitDirty), so an offline change made while serve was down
 * appears in the count before any new edit. Returns RELATIVE (git-root) paths, matching the
 * watcher's per-file relPath in the single-repo serve case. Any non-git/uncomparable
 * condition seeds an EMPTY set — the watcher still maintains it live from there, and
 * serveFreshness keeps the footer honest by degrading to `unknown` exactly when
 * computeFreshness would. The watcher then ADDS a file on its change event and REMOVES it
 * once that file is re-parsed, so the served count tracks the live graph, not the persisted index.
 */
export function seedDirtySet(
  opts: { projectRoot: string; indexedCommit: string | null | undefined },
): Set<string> {
  const r = gitDirty(opts.projectRoot, opts.indexedCommit);
  return r.kind === 'ok' ? r.files : new Set();
}

/**
 * The SERVE per-answer watermark ([#11] D2). Combines a `baseline` (commit + comparability
 * computed ONCE at serve startup — neither changes mid-session) with the watcher-maintained
 * live set's CURRENT size, so the footer reflects the live served graph with no git shell-out
 * per answer. When the baseline is already `unknown` (non-git / uncomparable / non-sha commit),
 * the live set is meaningless, so serve keeps reporting `unknown` — degrading exactly as the
 * cold path (computeFreshness) would, never crashing and never inventing a count.
 */
export function serveFreshness(baseline: Freshness, dirtySet: { size: number }): Freshness {
  if (baseline.dirty === 'unknown') return baseline;
  return { commit: baseline.commit, dirty: dirtySet.size };
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

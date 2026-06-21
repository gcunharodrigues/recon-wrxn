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

/**
 * The freshness watermark injected into answer formatting. `commit` is the indexed
 * short commit (or `none` outside a git repo); `dirty` is the live count of files
 * changed since the indexed commit plus uncommitted, or `'unknown'` outside a git repo.
 */
export interface Freshness {
  commit: string;
  dirty: number | 'unknown';
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
  const lines = [text, '', `---`, footer];
  if (opts.absence && dirtyCount > 0) {
    lines.push(
      `\n> WARNING: the working tree has uncommitted/unindexed changes — verify before acting on this absence (the graph may be stale).`,
    );
  }
  return lines.join('\n');
}

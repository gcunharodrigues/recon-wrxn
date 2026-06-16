/**
 * Shared walker selectivity — the single source of truth for what the
 * non-code analyzers (markdown + source) treat as NOISE.
 *
 * Consolidates the IGNORE_DIRS set that was duplicated across the markdown,
 * source, and tree-sitter (code) walkers (multiformat-distill-03): one set,
 * imported by all three, so every walker agrees on what is skipped — no drift.
 */

/**
 * Directory names pruned at the walk. Holds tooling/runtime/CI state, vendored
 * deps, and transient tool dumps — never authored content. Meaningful dot-dirs
 * (.claude/, .wrxn/) are intentionally NOT here: the wiki + dropped sources live
 * there and must be walked.
 */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.recon-wrxn', '.reference', 'vendor', 'target',
  'build', 'dist', 'out', '.venv', 'venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.cargo', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '.github', '.husky', '.next', '.turbo', '.cache', '.aiox',
  // Transient tool-dump dirs: machine-generated snapshots/traces, not content.
  '.playwright-mcp',
]);

/**
 * Real machine-generated dependency lockfiles, by EXACT name. Slice 02 indexes
 * .json/.yaml as Source nodes, which would otherwise pull these huge generated
 * files into the graph. An explicit allowlist (not a `*-lock.json` glob) keeps
 * the slice invariant — authored .json/.yml still index, no editorial judgment:
 * an authored `my-data-lock.json` is NOT a lockfile and must be kept, while a
 * real generated `npm-shrinkwrap.json` (which the glob missed) must be skipped.
 * `yarn.lock` needs no entry — `.lock` is not a connected format, so it is never
 * indexed in the first place.
 */
const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml']);

export function isLockfile(name: string): boolean {
  return LOCKFILE_NAMES.has(name.toLowerCase());
}

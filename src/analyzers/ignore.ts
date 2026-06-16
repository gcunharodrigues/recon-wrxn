/**
 * Shared walker selectivity — the single source of truth for what the
 * non-code analyzers (markdown + source) treat as NOISE.
 *
 * Consolidates the IGNORE_DIRS set that was duplicated across the markdown and
 * source walkers (multiformat-distill-03): one set, imported by both, so prose
 * and source always agree on what is skipped. The tree-sitter (code) analyzer
 * keeps its own copy — it walks a different file class.
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
 * True for machine-generated dependency lockfiles. Slice 02 indexes .json/.yaml
 * as Source nodes, which would otherwise pull these huge generated files into
 * the graph. Skips `pnpm-lock.yaml` and the `*-lock.json` shape (covers
 * `package-lock.json`). `yarn.lock` needs no rule — `.lock` is not a connected
 * format, so it is never indexed in the first place.
 */
export function isLockfile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'pnpm-lock.yaml' || lower.endsWith('-lock.json');
}

/**
 * Smoke test: the REAL embedder production seam (P1.5-D).
 *
 * Every other test injects a fake embedder — the production path (initEmbedder's
 * `Function('return import("@huggingface/transformers")')` pipeline load + the real
 * model inference in embedText) is otherwise UNCOVERED, because the transformers
 * model can't load under vitest's module environment. This runs the seam in a real
 * `node` subprocess against the BUILT dist and asserts embedText returns a 384-d
 * Float32Array.
 *
 * OPT-IN (slow — loads/maybe-downloads the ~90MB model): set RECON_EMBED_SMOKE=1.
 * CI should enable it (after `npm run build`, with @huggingface/transformers
 * installed). Skipped by default so the unit suite stays fast.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe.skipIf(process.env.RECON_EMBED_SMOKE !== '1')(
  'embedder production seam (real model, node subprocess)',
  () => {
    it('initEmbedder + embedText returns a 384-d Float32Array', () => {
      // Import the BUILT dist module (the seam under test) by absolute file URL so
      // the subprocess resolves it regardless of its own cwd. Distinct exit codes
      // make a failure self-describing in the inherited stderr.
      const url = pathToFileURL(resolve(process.cwd(), 'dist/search/embedder.js')).href;
      const script =
        `import(${JSON.stringify(url)}).then(async (m) => {` +
        `  await m.initEmbedder();` +
        `  const v = await m.embedText('the quick brown fox jumps');` +
        `  await m.disposeEmbedder();` +
        `  if (!(v instanceof Float32Array)) { console.error('not a Float32Array'); process.exit(2); }` +
        `  if (v.length !== 384) { console.error('unexpected dims: ' + v.length); process.exit(3); }` +
        `  process.exit(0);` +
        `}).catch((e) => { console.error(e); process.exit(1); });`;

      // execFileSync throws on a non-zero exit → the test fails with the subprocess
      // stderr (model load error, wrong dims, etc.). 120s covers a first-run download.
      execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        stdio: 'inherit',
        timeout: 120_000,
      });
      expect(true).toBe(true);
    });
  },
);

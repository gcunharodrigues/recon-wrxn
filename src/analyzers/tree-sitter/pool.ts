/**
 * Worker Pool for Parallel Tree-sitter Parsing
 *
 * Manages a pool of worker_threads that each run their own
 * tree-sitter Parser. Files are distributed round-robin and
 * results are collected via Promise.
 *
 * Usage:
 *   const pool = new TreeSitterPool(4);
 *   const results = await pool.parseFiles(files);
 *   pool.terminate();
 */

import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from '../../graph/types.js';
import type { FileExtractionResult } from './extractor.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ParseTask {
  filePath: string;
  content: string;
  language: Language;
}

export interface ParseResult {
  filePath: string;
  result: FileExtractionResult;
  error?: string;
}

// ─── Pool Config ────────────────────────────────────────────────

/** Minimum files before enabling workers (below this, sequential is faster) */
export const WORKER_THRESHOLD = 100;

/** Default pool size = CPU cores, capped at 8 */
export const DEFAULT_POOL_SIZE = Math.min(cpus().length, 8);

// ─── WorkerPool ─────────────────────────────────────────────────

export class TreeSitterPool {
  private workers: Worker[] = [];
  private size: number;
  private workerPath: string;
  private alive = false;

  constructor(size?: number) {
    this.size = size ?? DEFAULT_POOL_SIZE;

    // Resolve worker path relative to this file's compiled location
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.workerPath = join(thisDir, 'worker.js');
  }

  /**
   * Spawn worker threads.
   * Returns false if workers can't be created (fallback to sequential).
   */
  spawn(): boolean {
    try {
      for (let i = 0; i < this.size; i++) {
        const w = new Worker(this.workerPath);
        this.workers.push(w);
      }
      this.alive = true;
      return true;
    } catch (err) {
      // Clean up any workers that were created
      this.terminate();
      console.error(`[recon] Worker pool failed to start: ${err}`);
      return false;
    }
  }

  /**
   * Parse files in parallel using the worker pool.
   *
   * Distributes tasks round-robin across workers.
   * Returns a Map<filePath, FileExtractionResult>.
   *
   * Usage contract: single-shot per pool — the analyzer spawns, calls this
   * once, then terminate()s. Death listeners are registered/detached per call,
   * so reuse is safe, but a worker that died in a PRIOR call is not respawned;
   * re-issuing after a death would post to a dead worker (drained on its
   * lingering exit event, never hung). Spawn a fresh pool for a new batch.
   */
  async parseFiles(tasks: ParseTask[]): Promise<Map<string, ParseResult>> {
    if (!this.alive || this.workers.length === 0) {
      throw new Error('Worker pool not started. Call spawn() first.');
    }

    const results = new Map<string, ParseResult>();
    let nextId = 0;

    // Track unresolved task resolvers per worker so a worker that dies
    // (error/exit) before posting its result settles its in-flight tasks
    // with a parse warning instead of leaving Promise.all to hang forever.
    const pendingByWorker: Array<Map<number, { task: ParseTask; resolve: () => void }>> =
      this.workers.map(() => new Map());

    const settleDead = (workerIdx: number, reason: string) => {
      const pending = pendingByWorker[workerIdx];
      // Snapshot: each entry.resolve() (= settle) deletes from `pending`, so
      // iterate a copy to keep drain order independent of Map-mutation rules.
      for (const [, entry] of [...pending]) {
        results.set(entry.task.filePath, {
          filePath: entry.task.filePath,
          result: { symbols: [], calls: [], imports: [], heritage: [] },
          error: reason,
        });
        entry.resolve();
      }
      pending.clear();
    };

    // One error/exit listener per worker (not per task): a dead worker
    // drains ALL of its in-flight tasks at once. This relies on every task
    // being registered into pendingByWorker synchronously (in the tasks.map
    // below) BEFORE any death event can fire — worker events are async, the
    // map loop is sync — so no in-flight task can be missed by settleDead.
    const deathHandlers = this.workers.map((worker, workerIdx) => {
      const onError = (err: Error) =>
        settleDead(workerIdx, `worker crashed: ${err?.message ?? err}`);
      // Drain on ANY exit, including code 0: a normal end-of-life exit happens
      // with `pending` already empty (harmless no-op), but a worker that exits
      // 0 while tasks are still in-flight (never posted a result) would
      // otherwise hang Promise.all — the exact failure class this fix kills.
      const onExit = (code: number) =>
        settleDead(workerIdx, `worker exited before responding (code ${code})`);
      worker.on('error', onError);
      worker.on('exit', onExit);
      return { worker, onError, onExit };
    });

    // Create a promise for each task
    const promises = tasks.map((task) => {
      const id = nextId++;
      const workerIdx = id % this.workers.length;
      const worker = this.workers[workerIdx];

      return new Promise<void>((resolve) => {
        // settle() is the single exit for this task — on a normal message OR a
        // worker death (settleDead calls it). It detaches the per-task message
        // listener so a dead worker (which never posts) doesn't leak listeners.
        const settle = () => {
          pendingByWorker[workerIdx].delete(id);
          worker.off('message', handler);
          resolve();
        };
        pendingByWorker[workerIdx].set(id, { task, resolve: settle });

        const handler = (msg: { id: number; result?: FileExtractionResult; error?: string }) => {
          if (msg.id !== id) return; // Not our response (another task on this worker)
          if (!pendingByWorker[workerIdx].has(id)) return; // already settled by a worker death

          if (msg.error) {
            results.set(task.filePath, {
              filePath: task.filePath,
              result: { symbols: [], calls: [], imports: [], heritage: [] },
              error: msg.error,
            });
          } else {
            results.set(task.filePath, {
              filePath: task.filePath,
              result: msg.result!,
            });
          }
          settle();
        };

        worker.on('message', handler);
        worker.postMessage({
          id,
          filePath: task.filePath,
          content: task.content,
          language: task.language,
        });
      });
    });

    try {
      await Promise.all(promises);
    } finally {
      // Detach the death listeners so they don't accumulate across reuse of
      // a long-lived pool (terminate() at end of pool life fires exit too).
      for (const { worker, onError, onExit } of deathHandlers) {
        worker.off('error', onError);
        worker.off('exit', onExit);
      }
    }
    return results;
  }

  /**
   * Terminate all workers.
   */
  terminate(): void {
    for (const w of this.workers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    this.workers = [];
    this.alive = false;
  }

  /** Number of active workers */
  get poolSize(): number {
    return this.workers.length;
  }
}

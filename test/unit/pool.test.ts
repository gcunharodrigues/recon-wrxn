/**
 * Unit Tests: TreeSitterPool worker-death resilience (BL-043)
 *
 * A worker that dies (error/exit) before posting its result message must NOT
 * leave parseFiles() hanging on Promise.all forever. These tests inject a stub
 * worker so we can deterministically simulate a crash/exit without spawning a
 * real worker_thread. Without the fix the assertions time out (hang).
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { TreeSitterPool, type ParseTask } from '../../src/analyzers/tree-sitter/pool.js';
import { Language } from '../../src/graph/types.js';

/** Minimal stand-in for a worker_threads Worker as parseFiles uses it. */
interface PostedTask {
  id: number;
  filePath: string;
  content: string;
  language: Language;
}

class StubWorker extends EventEmitter {
  postMessage: (msg: PostedTask) => void;
  terminate = () => {};

  constructor(onPost: (self: StubWorker, msg: PostedTask) => void) {
    super();
    this.postMessage = (msg) => onPost(this, msg);
  }
}

function injectWorkers(pool: TreeSitterPool, workers: StubWorker[]): void {
  // `workers`/`alive` are private; bypass for test injection (no runtime guard).
  (pool as unknown as { workers: StubWorker[]; alive: boolean }).workers = workers;
  (pool as unknown as { alive: boolean }).alive = true;
}

const task = (filePath: string): ParseTask => ({
  filePath,
  content: 'x',
  language: Language.JavaScript,
});

const withTimeout = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('parseFiles hung (no settle)')), ms).unref(),
    ),
  ]);

describe('TreeSitterPool worker-death resilience', () => {
  it('settles an in-flight task when its worker emits error (no hang)', async () => {
    const worker = new StubWorker((self) => {
      // Crash before ever posting a message.
      setImmediate(() => self.emit('error', new Error('boom')));
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    const results = await withTimeout(pool.parseFiles([task('a.js')]));
    const r = results.get('a.js');
    expect(r).toBeDefined();
    expect(r!.error).toMatch(/worker crashed/);
    expect(r!.result.symbols).toEqual([]);
  });

  it('settles an in-flight task when its worker exits non-zero (no hang)', async () => {
    const worker = new StubWorker((self) => {
      setImmediate(() => self.emit('exit', 1));
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    const results = await withTimeout(pool.parseFiles([task('b.js')]));
    expect(results.get('b.js')!.error).toMatch(/exited before responding \(code 1\)/);
  });

  it('drains ALL in-flight tasks on a single worker death', async () => {
    const worker = new StubWorker((self) => {
      setImmediate(() => self.emit('error', new Error('boom')));
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    const results = await withTimeout(
      pool.parseFiles([task('a.js'), task('b.js'), task('c.js')]),
    );
    expect(results.size).toBe(3);
    for (const f of ['a.js', 'b.js', 'c.js']) {
      expect(results.get(f)!.error).toMatch(/worker crashed/);
    }
  });

  it('only the DEAD worker drains; a live sibling worker keeps producing results', async () => {
    // 2-worker pool: round-robin sends even ids to w0, odd ids to w1.
    // w0 crashes; w1 answers normally. Only w0's tasks must carry the error.
    const w0 = new StubWorker((self) => {
      setImmediate(() => self.emit('error', new Error('boom')));
    });
    const w1 = new StubWorker((self, msg) => {
      setImmediate(() =>
        self.emit('message', {
          id: msg.id,
          result: { symbols: [], calls: [], imports: [], heritage: [] },
        }),
      );
    });
    const pool = new TreeSitterPool(2);
    injectWorkers(pool, [w0, w1]);

    // a.js→id0→w0(dead), b.js→id1→w1(live), c.js→id2→w0(dead), d.js→id3→w1(live)
    const results = await withTimeout(
      pool.parseFiles([task('a.js'), task('b.js'), task('c.js'), task('d.js')]),
    );
    expect(results.size).toBe(4);
    expect(results.get('a.js')!.error).toMatch(/worker crashed/);
    expect(results.get('c.js')!.error).toMatch(/worker crashed/);
    expect(results.get('b.js')!.error).toBeUndefined();
    expect(results.get('d.js')!.error).toBeUndefined();
  });

  it('detaches all listeners after each call so a reused pool does not leak', async () => {
    const worker = new StubWorker((self, msg) => {
      setImmediate(() =>
        self.emit('message', {
          id: msg.id,
          result: { symbols: [], calls: [], imports: [], heritage: [] },
        }),
      );
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    for (let i = 0; i < 3; i++) {
      await withTimeout(pool.parseFiles([task(`f${i}.js`)]));
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('error')).toBe(0);
      expect(worker.listenerCount('exit')).toBe(0);
    }
  });

  it('detaches per-task message listeners even when the worker dies (no leak)', async () => {
    const worker = new StubWorker((self) => {
      setImmediate(() => self.emit('error', new Error('boom')));
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    await withTimeout(pool.parseFiles([task('a.js'), task('b.js')]));
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
  });

  it('a real result followed by a late non-zero exit keeps the real result (no overwrite)', async () => {
    // Race the fix guards against: the worker answers, then dies. The already-
    // settled task must NOT be re-stamped with a crash error by settleDead.
    const worker = new StubWorker((self, msg) => {
      setImmediate(() => {
        self.emit('message', {
          id: msg.id,
          result: { symbols: [], calls: [], imports: [], heritage: [] },
        });
        setImmediate(() => self.emit('exit', 1)); // dies AFTER answering
      });
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    const results = await withTimeout(pool.parseFiles([task('x.js')]));
    expect(results.get('x.js')!.error).toBeUndefined();
  });

  it('a code-0 exit while a task is in-flight (never answered) still settles (no hang)', async () => {
    // Defensive: a worker that exits cleanly (code 0) without ever posting a
    // result for its in-flight task must NOT hang Promise.all.
    const worker = new StubWorker((self) => {
      setImmediate(() => self.emit('exit', 0)); // exits 0, never answers
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    const results = await withTimeout(pool.parseFiles([task('gone.js')]));
    expect(results.get('gone.js')!.error).toMatch(/exited before responding/);
  });

  it('a clean exit (code 0) does not fabricate an error for a completed task', async () => {
    const worker = new StubWorker((self, msg) => {
      // Respond normally, then exit cleanly afterwards.
      setImmediate(() => {
        self.emit('message', {
          id: msg.id,
          result: { symbols: [], calls: [], imports: [], heritage: [] },
        });
        setImmediate(() => self.emit('exit', 0));
      });
    });
    const pool = new TreeSitterPool(1);
    injectWorkers(pool, [worker]);

    const results = await withTimeout(pool.parseFiles([task('ok.js')]));
    expect(results.get('ok.js')!.error).toBeUndefined();
  });
});

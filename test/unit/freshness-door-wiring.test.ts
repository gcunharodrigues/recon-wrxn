/**
 * Unit Tests: freshness footer wired through the HTTP door, computed at ANSWER TIME ([#9] D1)
 *
 * Proves the production seam end to end: createApp receives `indexedCommit`, and on each
 * request computes the watermark from git (against a REAL temp repo set as projectRoot),
 * so the footer reflects the LIVE dirty count — not a snapshot taken at startup. Also
 * proves graceful degradation when projectRoot is a non-git dir.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { createApp } from '../../src/server/http.js';
import { computeFreshness, serveFreshness } from '../../src/mcp/freshness.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recon-door-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
function node(id: string, name: string, over?: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/a.ts', startLine: 1, endLine: 5,
    language: Language.TypeScript, package: 'src', exported: true, ...over,
  };
}
function graphWith(name: string): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(node('f:1', name));
  return g;
}

describe('[#9] freshness wired through the HTTP door (answer-time compute)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('find over the door reflects the LIVE dirty count from the real repo', async () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const indexed = git(dir, 'rev-parse', '--short', 'HEAD');

    // Make the tree dirty AFTER "indexing" — the count is computed at answer time.
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');

    const app = createApp({
      port: 0, graph: graphWith('Widget'), projectRoot: dir, indexedCommit: indexed,
    });
    const res = await request(app).post('/api/tools/recon_find').send({ query: 'Widget' });

    expect(res.status).toBe(200);
    expect(res.body.result).toContain(`indexed @ ${indexed}, 2 files dirty`);
  });

  it('a non-git projectRoot degrades to `none` / `unknown`, no crash', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recon-door-nongit-'));
    const app = createApp({
      port: 0, graph: graphWith('Widget'), projectRoot: dir, indexedCommit: 'abc1234',
    });
    const res = await request(app).post('/api/tools/recon_find').send({ query: 'Widget' });

    expect(res.status).toBe(200);
    expect(res.body.result).toContain('indexed @ none, unknown files dirty');
  });

  it('explain over the door carries the footer too', async () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const indexed = git(dir, 'rev-parse', '--short', 'HEAD');

    const app = createApp({
      port: 0, graph: graphWith('Widget'), projectRoot: dir, indexedCommit: indexed,
    });
    const res = await request(app).post('/api/tools/recon_explain').send({ name: 'Widget' });

    expect(res.status).toBe(200);
    expect(res.body.result).toContain(`indexed @ ${indexed}, 0 files dirty`);
  });

  it('without indexedCommit the door stays footer-free (back-compat)', async () => {
    const app = createApp({ port: 0, graph: graphWith('Widget') });
    const res = await request(app).post('/api/tools/recon_find').send({ query: 'Widget' });

    expect(res.status).toBe(200);
    expect(res.body.result).not.toContain('indexed @');
  });
});

describe('[#11] serve footer reads the LIVE dirty set via freshnessProvider (D2)', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('the live-set count WINS over the on-demand git count (watcher absorbed the disk edits)', async () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const indexed = git(dir, 'rev-parse', '--short', 'HEAD');

    // The working tree is DIRTY on disk — the cold-path git count would be 2 ...
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');

    // ... but a live watcher has absorbed all but one file: the live set holds exactly ONE.
    const live = new Set<string>(['src/pending.ts']);
    const baseline = computeFreshness({ projectRoot: dir, indexedCommit: indexed });
    const app = createApp({
      port: 0, graph: graphWith('Widget'), projectRoot: dir, indexedCommit: indexed,
      freshnessProvider: () => serveFreshness(baseline, live),
    });
    const res = await request(app).post('/api/tools/recon_find').send({ query: 'Widget' });

    expect(res.status).toBe(200);
    // 1 (the live served graph), NOT 2 (git on disk) — proves serve reads the live set.
    expect(res.body.result).toContain(`indexed @ ${indexed}, 1 files dirty`);
  });

  it('a non-git baseline still degrades to unknown through the provider (no crash)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recon-d2-door-nongit-'));
    const baseline = computeFreshness({ projectRoot: dir, indexedCommit: 'abc1234' }); // → unknown
    const app = createApp({
      port: 0, graph: graphWith('Widget'), projectRoot: dir, indexedCommit: 'abc1234',
      freshnessProvider: () => serveFreshness(baseline, new Set(['x'])),
    });
    const res = await request(app).post('/api/tools/recon_find').send({ query: 'Widget' });

    expect(res.status).toBe(200);
    expect(res.body.result).toContain('indexed @ none, unknown files dirty');
  });
});

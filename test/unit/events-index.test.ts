/**
 * Unit Tests: SessionEvent ingestion on the real index pipeline (citation-recon
 * R1, recon-wrxn #18).
 *
 * The analyzer is unit-tested in events.test.ts; this asserts it is actually
 * WIRED into the index pipeline after prose ingestion. Runs the real indexProject
 * over a temp fixture dir containing `.wrxn/events/*.jsonl` and asserts the saved
 * graph gained SessionEvent nodes, that re-indexing is idempotent (same nodes),
 * and that the events are queryable (BM25 — the lexical ranker recon_find uses).
 *
 * Temp-dir style mirrors markdown-index-project.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProject } from '../../src/cli/commands.js';
import { loadIndex, loadSearchText } from '../../src/storage/store.js';
import { BM25Index } from '../../src/search/bm25.js';
import { NodeType } from '../../src/graph/types.js';

const REPO = 'evrepo';
const SID = 'sess-99';
let extDir: string;
let mainRoot: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  extDir = mkdtempSync(join(tmpdir(), 'recon-evidx-'));
  mainRoot = mkdtempSync(join(tmpdir(), 'recon-evidx-main-'));
  mkdirSync(join(extDir, '.wrxn', 'events'), { recursive: true });
  // A code file so the pipeline indexes a non-trivial graph (mirrors the precedent).
  writeFileSync(join(extDir, 'app.ts'), 'export const x = 1;\n');
  // One session log: a prompt, a tool call, and a malformed line that must be skipped.
  writeFileSync(
    join(extDir, '.wrxn', 'events', `${SID}.jsonl`),
    [
      JSON.stringify({ ts: '2026-06-23T09:00:00Z', sid: SID, kind: 'prompt', text: 'wire the citation moat into recon' }),
      'not even json',
      JSON.stringify({ ts: '2026-06-23T09:01:00Z', sid: SID, kind: 'tool', tool: 'Edit', target: 'src/commands.ts' }),
    ].join('\n') + '\n',
  );
  // indexProject is chatty on stderr by design; silence it for clean test output.
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  errSpy.mockRestore();
  rmSync(extDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

describe('indexProject wires SessionEvent ingestion after prose', () => {
  it('saves SessionEvent nodes (prompt + tool) into the graph, skipping the bad line', async () => {
    await indexProject(extDir, mainRoot, REPO);

    const stored = await loadIndex(mainRoot, REPO);
    expect(stored).not.toBeNull();
    const events = [...stored!.graph.nodes.values()].filter((n) => n.type === NodeType.SessionEvent);

    // Two valid records (prompt + tool); the malformed middle line is skipped.
    expect(events).toHaveLength(2);
    const prompt = events.find((n) => n.eventKind === 'prompt')!;
    const tool = events.find((n) => n.eventKind === 'tool')!;
    expect(prompt).toBeDefined();
    expect(prompt.package).toBe(SID);
    expect(prompt.ts).toBe('2026-06-23T09:00:00Z');
    expect(tool.tool).toBe('Edit');
    expect(tool.target).toBe('src/commands.ts');
    expect(stored!.graph.getNode(`event:${SID}:0`)).toBeDefined();
  });

  it('is idempotent — re-indexing the same events yields the same nodes', async () => {
    await indexProject(extDir, mainRoot, REPO);
    const first = [...(await loadIndex(mainRoot, REPO))!.graph.nodes.values()]
      .filter((n) => n.type === NodeType.SessionEvent)
      .map((n) => n.id)
      .sort();

    await indexProject(extDir, mainRoot, REPO);
    const second = [...(await loadIndex(mainRoot, REPO))!.graph.nodes.values()]
      .filter((n) => n.type === NodeType.SessionEvent)
      .map((n) => n.id)
      .sort();

    expect(second).toEqual(first);
    expect(second).toHaveLength(2);
  });

  it('makes SessionEvent nodes queryable (BM25 returns them by prompt text)', async () => {
    await indexProject(extDir, mainRoot, REPO);
    const stored = await loadIndex(mainRoot, REPO);
    const snapshot = (await loadSearchText(mainRoot, REPO)) ?? {};

    const bm25 = BM25Index.buildFromGraph(stored!.graph, snapshot);
    const hitIds = bm25.search('citation moat', 20).map((r) => r.nodeId);
    expect(hitIds).toContain(`event:${SID}:0`);
  });
});

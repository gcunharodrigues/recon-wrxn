/**
 * Unit Tests: SessionEvent ingestion (citation-recon R1, recon-wrxn #18).
 *
 * `analyzeEvents` lifts the kernel's session event source (.wrxn/events/*.jsonl,
 * the frozen wrxn-kernel #33 contract: one JSON object per line,
 * `{ ts, sid, kind, ... }` with kind ∈ { prompt, tool }) into the graph as
 * SessionEvent nodes — mirroring how the markdown analyzer lifts prose into
 * Page/Section nodes: a PURE function over already-read files (IO injected via a
 * separate findEventFiles walker), returning { nodes, relationships, searchText,
 * warnings }. The event body (a prompt's text) is kept OFF the node and carried
 * in the searchText snapshot, exactly like a prose body.
 *
 * Temp-dir style mirrors markdown-index.test.ts / markdown-index-project.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeEvents, findEventFiles } from '../../src/analyzers/events.js';
import { NodeType, Language } from '../../src/graph/types.js';

// ─── analyzeEvents: prompt records ───────────────────────────────

describe('analyzeEvents — prompt records', () => {
  it('lifts a prompt line into a SessionEvent node, body kept off the node', () => {
    const sid = 'sess-abc';
    const line = JSON.stringify({ ts: '2026-06-23T10:00:00Z', sid, kind: 'prompt', text: 'refactor the auth flow' });
    const result = analyzeEvents([{ path: '.wrxn/events/sess-abc.jsonl', content: line + '\n' }]);

    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node.type).toBe(NodeType.SessionEvent);
    expect(node.eventKind).toBe('prompt');
    expect(node.ts).toBe('2026-06-23T10:00:00Z');
    // sid is carried as the grouping dimension (package), mirroring prose package=dir.
    expect(node.package).toBe(sid);
    expect(node.id).toContain(sid);
    expect(node.file).toBe('.wrxn/events/sess-abc.jsonl');
    expect(node.language).toBe(Language.Json);
    expect(node.exported).toBe(false);

    // Body (prompt text) is OFF the serialized node, in the searchText snapshot.
    expect((node as Record<string, unknown>).text).toBeUndefined();
    expect(result.searchText[node.id]).toContain('refactor the auth flow');

    // R1 emits no event edges.
    expect(result.relationships).toEqual([]);
  });
});

// ─── analyzeEvents: tool records ─────────────────────────────────

describe('analyzeEvents — tool records', () => {
  it('lifts a tool line into a SessionEvent node carrying tool + target', () => {
    const sid = 'sess-xyz';
    const line = JSON.stringify({ ts: '2026-06-23T11:00:00Z', sid, kind: 'tool', tool: 'Edit', target: 'src/auth.ts' });
    const result = analyzeEvents([{ path: '.wrxn/events/sess-xyz.jsonl', content: line + '\n' }]);

    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node.type).toBe(NodeType.SessionEvent);
    expect(node.eventKind).toBe('tool');
    expect(node.tool).toBe('Edit');
    expect(node.target).toBe('src/auth.ts');
    expect(node.ts).toBe('2026-06-23T11:00:00Z');
    expect(node.package).toBe(sid);
    // The tool label is queryable via the snapshot (tool name + target).
    expect(result.searchText[node.id]).toContain('Edit');
    expect(result.searchText[node.id]).toContain('src/auth.ts');
  });
});

// ─── analyzeEvents: malformed / off-contract lines ───────────────

describe('analyzeEvents — bad lines are skipped, never throw', () => {
  it('skips non-JSON / off-contract / blank lines but keeps the valid records', () => {
    const sid = 'sess-mix';
    const content = [
      JSON.stringify({ ts: 't1', sid, kind: 'prompt', text: 'first prompt' }),
      'this is not json at all',                          // non-JSON → skip
      '{ "ts": "t2", broken json',                        // malformed JSON → skip
      '',                                                  // blank → skip
      JSON.stringify({ ts: 't3', sid, kind: 'weird' }),  // off-contract kind → skip
      JSON.stringify({ ts: 't4', kind: 'prompt', text: 'no sid here' }), // missing sid → skip
      JSON.stringify(['not', 'an', 'object']),           // JSON array, not a record → skip
      JSON.stringify({ ts: 't5', sid, kind: 'tool', tool: 'Read', target: 'a.ts' }),
    ].join('\n');

    let result!: ReturnType<typeof analyzeEvents>;
    expect(() => {
      result = analyzeEvents([{ path: '.wrxn/events/sess-mix.jsonl', content }]);
    }).not.toThrow();

    // Only the two well-formed records (prompt + tool) survive the bad lines.
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.eventKind).sort()).toEqual(['prompt', 'tool']);
    // A skipped bad LINE is not a skipped FILE — no warning is recorded.
    expect(result.warnings).toEqual([]);
  });
});

// ─── analyzeEvents: deterministic / idempotent ids ───────────────

describe('analyzeEvents — deterministic node ids', () => {
  it('produces identical ids for the same input (re-index is idempotent)', () => {
    const sid = 'sess-det';
    const content = [
      JSON.stringify({ ts: 't1', sid, kind: 'prompt', text: 'a' }),
      JSON.stringify({ ts: 't2', sid, kind: 'tool', tool: 'Edit', target: 'x.ts' }),
    ].join('\n');
    const file = { path: '.wrxn/events/sess-det.jsonl', content };

    const first = analyzeEvents([file]);
    const second = analyzeEvents([file]);
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
    // ids are derived from sid + line index, so they survive a re-index unchanged.
    expect(first.nodes.map((n) => n.id)).toEqual(['event:sess-det:0', 'event:sess-det:1']);
  });
});

// ─── findEventFiles: the injected IO walker ──────────────────────

describe('findEventFiles', () => {
  it('discovers .wrxn/events/*.jsonl with project-relative paths, ignoring other files', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-ev-'));
    try {
      mkdirSync(join(root, '.wrxn', 'events'), { recursive: true });
      writeFileSync(join(root, '.wrxn', 'events', 'sess-1.jsonl'), '{"ts":"t","sid":"sess-1","kind":"prompt","text":"hi"}\n');
      writeFileSync(join(root, '.wrxn', 'events', 'sess-2.jsonl'), '{"ts":"t","sid":"sess-2","kind":"tool","tool":"Read","target":"a.ts"}\n');
      writeFileSync(join(root, '.wrxn', 'events', 'notes.txt'), 'not an event log');

      const files = findEventFiles(root);
      expect(files.map((f) => f.path).sort()).toEqual([
        '.wrxn/events/sess-1.jsonl',
        '.wrxn/events/sess-2.jsonl',
      ]);
      expect(files.find((f) => f.path.endsWith('sess-1.jsonl'))!.content).toContain('"sid":"sess-1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns [] when .wrxn/events is absent (fail-open)', () => {
    const root = mkdtempSync(join(tmpdir(), 'recon-ev-empty-'));
    try {
      expect(findEventFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

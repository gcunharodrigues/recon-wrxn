/**
 * Session Event Analyzer (citation-recon R1, recon-wrxn #18)
 *
 * Lifts the kernel's session event source into the same knowledge graph as code
 * and prose, so a query can surface what a session actually did. Mirrors the
 * markdown analyzer's shape: a pure function returning { nodes, relationships }
 * (plus a searchText snapshot + per-file warnings), with file IO injected via a
 * separate walker (findEventFiles) so the analysis is unit-testable without fs.
 *
 * Input is the FROZEN event-JSONL contract (wrxn-kernel #33, shipped): one JSON
 * object per line in `.wrxn/events/<sid>.jsonl`, `{ ts, sid, kind, ... }` with
 * `kind ∈ { prompt, tool }` — a `prompt` record carries `text`, a `tool` record
 * carries `tool` + `target`. No fields are invented beyond this contract.
 *
 * Emits one SessionEvent node per valid record — id `event:<file>:<line>` (file =
 * the source basename with its extension stripped; the line index disambiguates
 * and is deterministic, so re-indexing the same file yields the same ids →
 * idempotent). Basing the id on the FILE rather than the record's `sid` keeps ids
 * unique per source file even if a tampered file carries a foreign `sid` (in
 * normal operation — one sid per events/<sid>.jsonl — the basename equals the sid,
 * so ids are unchanged). The prompt body is kept OFF the serialized
 * node and returned in `searchText` (the BM25 input), exactly as a prose body is.
 * A malformed / non-JSON / off-contract line is skipped; analysis never throws.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { NodeType, Language } from '../graph/types.js';
import type { Node, Relationship } from '../graph/types.js';
import type { AnalyzerWarning } from './types.js';

// ─── Types ───────────────────────────────────────────────────────

export interface EventFile {
  /** Project-relative path (POSIX separators). Used in node ids' `file` field. */
  path: string;
  /** Raw `.jsonl` file content (one JSON record per line). */
  content: string;
}

export interface EventAnalysisResult {
  nodes: Node[];
  /** Always empty in R1 — session events carry no graph edges yet. */
  relationships: Relationship[];
  /**
   * nodeId → searchText. The prompt body (and a tool's label) live here so the
   * body stays OFF the served node while remaining the lexical (BM25) input,
   * mirroring the prose search-text snapshot.
   */
  searchText: Record<string, string>;
  /** Files whose analysis threw and were SKIPPED (mirrors the prose warnings[]). */
  warnings: AnalyzerWarning[];
}

// ─── File discovery ──────────────────────────────────────────────

/**
 * Discover `.wrxn/events/*.jsonl` under a project root, returning each as
 * { path, content }. Events live in one fixed framework location (not strewn
 * through the tree), so this is a flat read of that dir — no deep walk. Returns
 * [] when the dir is absent (fail-open: a project without session telemetry just
 * ingests nothing). The IO half of the analyzer, kept separate so analyzeEvents
 * stays pure (mirrors findMarkdownFiles ↔ analyzeMarkdown).
 *
 * `maxFileSize` (bytes) is the OPTIONAL OOM escape hatch threaded from ingestProse,
 * identical to the prose/source walkers: a file strictly larger is skipped via
 * statSync BEFORE the whole-file read. DEFAULTS to Infinity = no cap.
 */
export function findEventFiles(rootDir: string, maxFileSize: number = Infinity): EventFile[] {
  const dir = join(rootDir, '.wrxn', 'events');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: EventFile[] = [];
  // Sort by name so node output order is deterministic across platforms.
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
    const abs = join(dir, entry.name);
    // Only stat when a finite cap is configured — the default (unlimited) path
    // skips the extra syscall and never excludes a file by size.
    if (Number.isFinite(maxFileSize)) {
      try {
        if (statSync(abs).size > maxFileSize) continue;
      } catch {
        continue;
      }
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    out.push({ path: relative(rootDir, abs).replace(/\\/g, '/'), content });
  }
  return out;
}

// ─── Analyzer ────────────────────────────────────────────────────

function analyzeEventFile(file: EventFile, out: EventAnalysisResult): void {
  // Node ids are keyed on the SOURCE FILE (basename, ext stripped), not the
  // record's sid: filenames are unique within the flat .wrxn/events dir, so this
  // is unique-per-file AND deterministic — a tampered file reusing a foreign sid
  // can't collide ids across files (addNode would otherwise shadow).
  const fileKey = basename(file.path, extname(file.path));
  const lines = file.content.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return; // blank line → skip

    // A malformed / non-JSON line is skipped per-LINE (the good records around it
    // survive) and never throws — distinct from a per-FILE skip (analyzeEvents'
    // outer catch), which would drop every record in the file.
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return; // not a record → skip

    const kind = rec.kind;
    if (kind !== 'prompt' && kind !== 'tool') return; // off-contract kind → skip

    const sid = typeof rec.sid === 'string' ? rec.sid : undefined;
    if (!sid) return; // contract requires sid → skip
    const ts = rec.ts === undefined || rec.ts === null ? undefined : String(rec.ts);

    const id = `event:${fileKey}:${i}`;
    const node: Node = {
      id,
      type: NodeType.SessionEvent,
      name: ts ? `${kind} @ ${ts}` : kind,
      file: file.path,
      startLine: i + 1,
      endLine: i + 1,
      language: Language.Json,
      package: sid, // group events by session, mirroring prose package=directory
      exported: false,
      eventKind: kind,
    };
    if (ts) node.ts = ts;

    if (kind === 'tool') {
      const tool = typeof rec.tool === 'string' ? rec.tool : undefined;
      const target = typeof rec.target === 'string' ? rec.target : undefined;
      if (tool) node.tool = tool;
      if (target) node.target = target;
      const label = [tool, target].filter(Boolean).join(' ');
      if (label) out.searchText[id] = label; // tool name + target → queryable
    } else {
      const text = typeof rec.text === 'string' ? rec.text : '';
      if (text) out.searchText[id] = text; // prompt body OFF the node, into the snapshot
    }

    out.nodes.push(node);
  });
}

/**
 * Analyze session-event files into SessionEvent graph nodes + a searchText
 * snapshot. Pure: depends only on the given file contents (the walker is
 * separate). A file whose analysis throws records a warning and is SKIPPED
 * rather than aborting the pass (mirrors analyzeMarkdown).
 */
export function analyzeEvents(files: EventFile[]): EventAnalysisResult {
  const out: EventAnalysisResult = { nodes: [], relationships: [], searchText: {}, warnings: [] };
  for (const file of files) {
    try {
      analyzeEventFile(file, out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.warnings.push({ file: file.path, reason: message.split('\n')[0] });
    }
  }
  return out;
}

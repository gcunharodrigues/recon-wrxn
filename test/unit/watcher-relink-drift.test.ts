/**
 * Regression: an in-place EDIT of a watermarked source symbol must NOT false-orphan
 * the page that documents it (phase-4.5-01/02 invariant).
 *
 * recon_drift (drift.ts computeDrift) flags a watermarked page as `orphaned` when its
 * `derived_from` anchor resolves to ZERO targets. On a live source EDIT (not a delete)
 * the watcher's `relinkCallers` re-creates the page→symbol DOCUMENTED_BY edge at
 * RELINK_CONFIDENCE; computeDrift keeps anchor edges with `confidence >
 * CITATION_CONFIDENCE`, so as long as RELINK_CONFIDENCE > CITATION_CONFIDENCE the page
 * keeps a live anchor target and is NEVER orphaned. If RELINK_CONFIDENCE ever dropped to
 * ≤ CITATION_CONFIDENCE, EVERY page documenting a recently-edited source would flip to
 * false-orphaned — and nothing else in the suite would catch it. This test pins that.
 *
 * It drives the real watcher `processFile` (the documented core surgical-update seam)
 * and then computes drift over the mutated graph, exactly as `serve` would.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReconWatcher } from '../../src/watcher/watcher.js';
import { extractFromFile, buildGraphFromExtractions } from '../../src/analyzers/tree-sitter/index.js';
import type { FileExtractionResult } from '../../src/analyzers/tree-sitter/index.js';
import { isLanguageAvailable } from '../../src/analyzers/tree-sitter/parser.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import { ANCHOR_CONFIDENCE, CITATION_CONFIDENCE } from '../../src/analyzers/doc-edges.js';
import { computeDrift } from '../../src/mcp/drift.js';

// login defined plainly; then the same login MOVED down by a helper inserted above it
// (body byte-identical — a pure move, the canonical "edit, not delete" case).
const SRC_ORIGINAL = `export function login(user: string): boolean {\n  return user.length > 0;\n}\n`;
const SRC_EDITED = `function helper(): number {\n  return 1;\n}\n\nexport function login(user: string): boolean {\n  return user.length > 0;\n}\n`;

const PAGE_ID = 'md:page:docs/auth.md';
let root: string;
let watcher: ReconWatcher | null = null;

afterEach(() => {
  watcher?.stop(); // clear the auto-save timer so vitest doesn't hang
  watcher = null;
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Drive the watcher's core surgical update for one file event (past the private modifier). */
function fire(w: ReconWatcher, abs: string, event: 'change'): Promise<void> {
  return (w as unknown as { processFile(a: string, r: string, e: string): Promise<void> })
    .processFile(abs, 'proj', event);
}

describe('watcher relink × drift — an edited source symbol stays tracked, never false-orphaned', () => {
  it('a watermarked page keeps a live anchor (not orphaned) after the source is edited in place', async () => {
    expect(isLanguageAvailable(Language.TypeScript)).toBe(true); // setup precondition

    root = mkdtempSync(join(tmpdir(), 'recon-relink-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth.ts'), SRC_ORIGINAL);

    // Index the source the way `recon index` does (buildGraphFromExtractions carries
    // the fingerprint), so `login` enters the graph fingerprinted.
    const graph = new KnowledgeGraph();
    const ext = extractFromFile('src/auth.ts', SRC_ORIGINAL, Language.TypeScript);
    const files = new Map<string, FileExtractionResult>([['src/auth.ts', ext]]);
    const built = buildGraphFromExtractions(files);
    for (const n of built.nodes) graph.addNode(n);
    for (const r of built.relationships) graph.addRelationship(r);

    const login = [...graph.nodes.values()].find((n) => n.name === 'login' && n.type === NodeType.Function);
    expect(login).toBeDefined();
    expect(login!.fingerprint).toBeTruthy(); // the watermark we sync against

    // A watermarked derived page anchored to `login` at its CURRENT fingerprint → fresh.
    graph.addNode({
      id: PAGE_ID, type: NodeType.Page, name: 'Auth Guide', file: 'docs/auth.md',
      startLine: 1, endLine: 40, language: Language.Markdown, package: 'docs',
      exported: false, syncedTo: login!.fingerprint,
    });
    graph.addRelationship({
      id: `${PAGE_ID}-DOCUMENTED_BY-${login!.id}`,
      type: RelationshipType.DOCUMENTED_BY,
      sourceId: PAGE_ID, targetId: login!.id, confidence: ANCHOR_CONFIDENCE,
    });

    // Baseline: tracked + fresh, nothing orphaned.
    const before = computeDrift(graph);
    expect(before.orphaned).toHaveLength(0);
    expect(before.fresh).toBe(1);

    // EDIT (not delete) the source: move `login` down. Fire the change through the watcher.
    watcher = new ReconWatcher(graph, [{ dir: root, repoName: 'proj' }], 50, [], root);
    writeFileSync(join(root, 'src', 'auth.ts'), SRC_EDITED);
    await fire(watcher, join(root, 'src', 'auth.ts'), 'change');

    const after = computeDrift(graph);

    // THE INVARIANT: an edit must NEVER false-orphan the documenting page.
    expect(after.orphaned).toHaveLength(0);

    // WHY it holds: relinkCallers re-created the page→symbol DOCUMENTED_BY edge at
    // RELINK_CONFIDENCE, which exceeds CITATION_CONFIDENCE — so it survives drift's
    // confidence filter and the page still resolves to its live source symbol.
    const edge = graph
      .getOutgoing(PAGE_ID, RelationshipType.DOCUMENTED_BY)
      .find((e) => e.targetId === login!.id);
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBeGreaterThan(CITATION_CONFIDENCE);

    // The page is still a TRACKED, resolvable watermarked page — present in a
    // resolvable bucket, never dropped. (In today's watcher it lands in
    // `uncomparable`: surgicalUpdateTreeSitter re-extracts the symbol WITHOUT
    // carrying its fingerprint forward — unlike buildGraphFromExtractions — so there
    // is no live fingerprint to compare. The invariant under test is only that it is
    // NOT orphaned; this OR keeps the test robust if the watcher later preserves the
    // fingerprint and the page lands in stale/fresh instead.)
    const stillTracked =
      after.uncomparable.some((e) => e.page === 'Auth Guide') ||
      after.stale.some((e) => e.page === 'Auth Guide') ||
      after.fresh > 0;
    expect(stillTracked).toBe(true);
  });
});

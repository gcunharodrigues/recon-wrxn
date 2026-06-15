/**
 * Unit Tests: BM25Index — prose searchText indexing (recon-prose-analyzer-02)
 *
 * Slice 01 froze prose nodes (Page/Section, body OFF the node) and persists the
 * heading+body text in a search-text.json snapshot keyed by node id. This slice
 * teaches BM25Index.buildFromGraph to index a prose node over that searchText so
 * a query term living only in the body (not the name/file) can rank the page.
 * Code nodes keep their name+file+package document — unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { BM25Index } from '../../src/search/bm25.js';

function codeNode(id: string, name: string, overrides?: Partial<Node>): Node {
  return {
    id,
    type: NodeType.Function,
    name,
    file: 'src/auth/login.ts',
    startLine: 1,
    endLine: 10,
    language: Language.TypeScript,
    package: 'src/auth',
    exported: true,
    ...overrides,
  };
}

function pageNode(file: string, name: string): Node {
  return {
    id: `md:page:${file}`,
    type: NodeType.Page,
    name,
    file,
    startLine: 1,
    endLine: 1,
    language: Language.Markdown,
    package: 'docs',
    exported: false,
  };
}

describe('BM25Index.buildFromGraph — prose searchText indexing', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph();
  });

  it('indexes a prose node over its searchText so a body-only term ranks the page', () => {
    // The page's name/file say nothing about "telemetry"; only its body does.
    const page = pageNode('docs/observability.md', 'Observability');
    graph.addNode(page);
    const searchText = {
      [page.id]: 'Observability overview — the telemetry pipeline ships spans to the collector',
    };

    const index = BM25Index.buildFromGraph(graph, searchText);
    const results = index.search('telemetry');

    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe(page.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('does NOT match a body term when no searchText is supplied (proves searchText is the source)', () => {
    const page = pageNode('docs/observability.md', 'Observability');
    graph.addNode(page);

    // No searchText arg → body never indexed → the body-only term cannot match.
    const index = BM25Index.buildFromGraph(graph);
    expect(index.search('telemetry')).toHaveLength(0);
  });

  it('keeps code nodes searchable by name (backward compatible, with and without searchText)', () => {
    graph.addNode(codeNode('ts:func:validateToken', 'validateToken'));

    const noText = BM25Index.buildFromGraph(graph);
    const withText = BM25Index.buildFromGraph(graph, {});

    expect(noText.search('validate token')[0]?.nodeId).toBe('ts:func:validateToken');
    expect(withText.search('validate token')[0]?.nodeId).toBe('ts:func:validateToken');
  });

  it('ranks a prose node by a rare body term above a code node that only path-matches', () => {
    const page = pageNode('docs/handoff.md', 'Handoff');
    graph.addNode(page);
    graph.addNode(codeNode('ts:func:handoffUtil', 'handoffUtil', { file: 'src/handoff.ts' }));
    const searchText = {
      [page.id]: 'Handoff — compaction baton continuity protocol for the next agent',
    };

    const index = BM25Index.buildFromGraph(graph, searchText);
    const top = index.search('continuity baton')[0];

    expect(top.nodeId).toBe(page.id);
  });

  it('still skips File nodes', () => {
    graph.addNode(codeNode('ts:file:src/x.ts', 'x.ts', { type: NodeType.File }));
    const index = BM25Index.buildFromGraph(graph, {});
    expect(index.documentCount).toBe(0);
  });
});

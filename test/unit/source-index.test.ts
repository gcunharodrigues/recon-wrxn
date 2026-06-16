/**
 * Unit Tests: Source index ingestion — walker, graph integration, findability.
 *
 * Covers the path `recon index` uses for multi-format sources (multiformat-
 * distill-01): findSourceFiles (own walker) → analyzeSource → graph + searchText
 * snapshot, and that a text-native Source node is returned by lexical search
 * (BM25) on its body content. Temp-dir fixtures, mirroring markdown-index.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSourceFiles, analyzeSource } from '../../src/analyzers/source.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { BM25Index } from '../../src/search/bm25.js';
import { NodeType } from '../../src/graph/types.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recon-src-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'page.html'),
    '<html><body><h1>Quantum Computing</h1><p>Qubits and superposition.</p></body></html>',
  );
  writeFileSync(join(root, 'notes.txt'), 'Plain note about photosynthesis.\n');
  writeFileSync(join(root, 'docs', 'study.pdf'), '%PDF-1.4 binary bytes here');
  writeFileSync(join(root, 'report.docx'), 'PK\x03\x04 zip bytes');
  writeFileSync(join(root, 'node_modules', 'pkg', 'dep.html'), '<p>ignored dep</p>');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findSourceFiles', () => {
  it('finds html/txt/pdf/docx and skips node_modules', () => {
    const files = findSourceFiles(root);
    expect(files.map((f) => f.path).sort()).toEqual([
      'docs/page.html',
      'docs/study.pdf',
      'notes.txt',
      'report.docx',
    ]);
    expect(files.some((f) => f.path.includes('node_modules'))).toBe(false);
  });

  it('reads text-native content but NOT binary bytes', () => {
    const files = findSourceFiles(root);
    const html = files.find((f) => f.path === 'docs/page.html')!;
    const pdf = files.find((f) => f.path === 'docs/study.pdf')!;
    expect(html.kind).toBe('text');
    expect(html.content).toContain('Quantum Computing');
    expect(pdf.kind).toBe('binary');
    expect(pdf.content).toBeUndefined();
  });

  it('respects path-prefix ignore patterns', () => {
    const files = findSourceFiles(root, ['docs']);
    expect(files.map((f) => f.path).sort()).toEqual(['notes.txt', 'report.docx']);
  });
});

describe('Source ingestion → BM25 findability', () => {
  it('a .html Source node is returned by lexical search on its stripped text content', () => {
    const result = analyzeSource(findSourceFiles(root));
    const graph = new KnowledgeGraph();
    for (const n of result.nodes) graph.addNode(n);

    const bm25 = BM25Index.buildFromGraph(graph, result.searchText);
    const hits = bm25.search('quantum superposition').map((h) => h.nodeId);
    expect(hits).toContain('source:docs/page.html');

    // all Source nodes present in the graph, including the minimal binary ones
    const sources = [...graph.nodes.values()].filter((n) => n.type === NodeType.Source);
    expect(sources.map((n) => n.id).sort()).toEqual([
      'source:docs/page.html',
      'source:docs/study.pdf',
      'source:notes.txt',
      'source:report.docx',
    ]);
  });

  it('a .txt Source node is findable by its body', () => {
    const result = analyzeSource(findSourceFiles(root));
    const graph = new KnowledgeGraph();
    for (const n of result.nodes) graph.addNode(n);
    const bm25 = BM25Index.buildFromGraph(graph, result.searchText);
    expect(bm25.search('photosynthesis').map((h) => h.nodeId)).toContain('source:notes.txt');
  });
});

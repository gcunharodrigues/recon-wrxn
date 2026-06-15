/**
 * Unit Tests: Markdown index ingestion — walker, graph integration, snapshot.
 *
 * Covers the path `recon index` uses for prose: findMarkdownFiles (own walker,
 * since tree-sitter rejects .md) → analyzeMarkdown → graph, plus the
 * search-text.json snapshot persisted alongside graph.json. Uses temp-dir
 * fixtures in the style of find-source-files-ignore.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findMarkdownFiles, analyzeMarkdown } from '../../src/analyzers/markdown.js';
import { saveSearchText, loadSearchText } from '../../src/storage/store.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType } from '../../src/graph/types.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recon-md-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Readme\nRoot readme body.\n');
  writeFileSync(
    join(root, 'docs', 'guide.md'),
    '---\ntitle: Guide\n---\n# Guide\nGuide body.\n\n## Details\nDetail text.\n',
  );
  writeFileSync(join(root, 'sub', 'notes.md'), '# Notes\nNote body.\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'dep.md'), '# Dep\nIgnored.\n');
  writeFileSync(join(root, 'docs', 'app.ts'), 'export const x = 1;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── findMarkdownFiles ───────────────────────────────────────────

describe('findMarkdownFiles', () => {
  it('finds .md files and returns project-relative path + content', () => {
    const files = findMarkdownFiles(root);
    expect(files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'docs/guide.md',
      'sub/notes.md',
    ]);
    const guide = files.find((f) => f.path === 'docs/guide.md')!;
    expect(guide.content).toContain('Guide body.');
  });

  it('skips node_modules', () => {
    const files = findMarkdownFiles(root);
    expect(files.some((f) => f.path.includes('node_modules'))).toBe(false);
  });

  it('ignores non-markdown files', () => {
    const files = findMarkdownFiles(root);
    expect(files.some((f) => f.path.endsWith('.ts'))).toBe(false);
  });

  it('respects path-prefix ignore patterns', () => {
    const files = findMarkdownFiles(root, ['docs']);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'sub/notes.md']);
  });
});

// ─── Index ingestion (walk → analyze → graph) ────────────────────

describe('recon index over a fixture dir containing .md', () => {
  it('produces a graph with Page and Section nodes', () => {
    const result = analyzeMarkdown(findMarkdownFiles(root));
    const graph = new KnowledgeGraph();
    for (const n of result.nodes) graph.addNode(n);
    for (const r of result.relationships) graph.addRelationship(r);

    const pages = [...graph.nodes.values()].filter((n) => n.type === NodeType.Page);
    const sections = [...graph.nodes.values()].filter((n) => n.type === NodeType.Section);
    // 3 pages (README, guide, notes); guide has 2 sections → ≥4 sections total
    expect(pages).toHaveLength(3);
    expect(sections.length).toBeGreaterThanOrEqual(4);
    expect(graph.getNode('md:page:docs/guide.md')).toBeDefined();
  });
});

// ─── search-text.json snapshot ───────────────────────────────────

describe('search-text.json snapshot persistence', () => {
  it('saveSearchText writes a snapshot in .recon-wrxn/ that loadSearchText reads back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-st-'));
    try {
      const snapshot = {
        'md:page:a.md': 'alpha page body',
        'md:section:a.md#intro@1': 'Intro section text',
      };
      await saveSearchText(dir, snapshot);
      expect(existsSync(join(dir, '.recon-wrxn', 'search-text.json'))).toBe(true);
      expect(await loadSearchText(dir)).toEqual(snapshot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadSearchText returns null when no snapshot exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-st-'));
    try {
      expect(await loadSearchText(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

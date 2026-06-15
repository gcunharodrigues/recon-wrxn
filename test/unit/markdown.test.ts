/**
 * Unit Tests: Markdown prose analyzer (analyzeMarkdown)
 *
 * The foundation slice: markdown becomes graph nodes. A pure function over
 * in-memory markdown fixtures → Page + Section nodes, Page CONTAINS Section
 * edges, and a searchText snapshot (heading + body, kept OFF the node).
 *
 * Asserts external behavior (node/edge shape, ids, searchText), never the
 * parser internals. Mirrors find.test.ts / graph.test.ts style.
 */
import { describe, it, expect } from 'vitest';
import { analyzeMarkdown } from '../../src/analyzers/markdown.js';
import type { MarkdownFile } from '../../src/analyzers/markdown.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';

// ─── Fixtures ────────────────────────────────────────────────────

const GUIDE_MD = [
  '---',
  'title: The Guide',
  '---',
  'Intro before any heading.',
  '',
  '# Overview',
  'Overview body text.',
  '',
  '## Setup',
  'Setup instructions here.',
  '',
  '## Setup',
  'A second identical Setup heading.',
  '',
].join('\n');

// No frontmatter title; a `#` inside a fenced code block must NOT become a Section.
const NOTES_MD = [
  '# Plain',
  'Body of plain.',
  '',
  '```js',
  '# fake heading inside a code fence',
  'const x = 1;',
  '```',
  '',
].join('\n');

function fixtures(): MarkdownFile[] {
  return [
    { path: 'docs/guide.md', content: GUIDE_MD },
    { path: 'notes.md', content: NOTES_MD },
  ];
}

// 1-based line of an exact source line within a fixture.
function lineOf(src: string, exact: string): number {
  return src.split('\n').findIndex((l) => l === exact) + 1;
}

// ─── Page nodes ──────────────────────────────────────────────────

describe('analyzeMarkdown — Page nodes', () => {
  it('emits one Page node per file', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const pages = nodes.filter((n) => n.type === NodeType.Page);
    expect(pages.map((p) => p.id).sort()).toEqual([
      'md:page:docs/guide.md',
      'md:page:notes.md',
    ]);
  });

  it('Page id, language, file, and exported flag follow the prose contract', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const page = nodes.find((n) => n.id === 'md:page:docs/guide.md')!;
    expect(page.type).toBe(NodeType.Page);
    expect(page.language).toBe(Language.Markdown);
    expect(page.file).toBe('docs/guide.md');
    expect(page.exported).toBe(false);
  });

  it('Page name is the frontmatter title when present', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const page = nodes.find((n) => n.id === 'md:page:docs/guide.md')!;
    expect(page.name).toBe('The Guide');
  });

  it('Page name falls back to the filename when no frontmatter title', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const page = nodes.find((n) => n.id === 'md:page:notes.md')!;
    expect(page.name).toBe('notes.md');
  });

  it('Page node does NOT carry body text (body-OFF)', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const page = nodes.find((n) => n.id === 'md:page:docs/guide.md')!;
    expect('body' in page).toBe(false);
    // The body text lives only in the searchText snapshot, never on the node.
    expect(JSON.stringify(page)).not.toContain('Overview body text');
  });
});

// ─── Section nodes ───────────────────────────────────────────────

describe('analyzeMarkdown — Section nodes', () => {
  it('emits one Section node per heading', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const sections = nodes.filter((n) => n.type === NodeType.Section);
    // guide.md: Overview, Setup, Setup (3) + notes.md: Plain (1) = 4
    expect(sections).toHaveLength(4);
    const names = sections.map((s) => s.name).sort();
    expect(names).toEqual(['Overview', 'Plain', 'Setup', 'Setup']);
  });

  it('Section carries name, startLine, language, and exported:false', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const overview = nodes.find(
      (n) => n.type === NodeType.Section && n.name === 'Overview',
    )!;
    expect(overview.language).toBe(Language.Markdown);
    expect(overview.file).toBe('docs/guide.md');
    expect(overview.exported).toBe(false);
    expect(overview.startLine).toBe(lineOf(GUIDE_MD, '# Overview'));
    expect(overview.id).toBe(
      `md:section:docs/guide.md#overview@${lineOf(GUIDE_MD, '# Overview')}`,
    );
  });

  it('two identical headings in one file do NOT collide (line in the id)', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const setups = nodes.filter(
      (n) => n.type === NodeType.Section && n.name === 'Setup',
    );
    expect(setups).toHaveLength(2);
    const ids = new Set(setups.map((s) => s.id));
    expect(ids.size).toBe(2);
    const lines = new Set(setups.map((s) => s.startLine));
    expect(lines.size).toBe(2);
  });

  it('a `#` inside a fenced code block does NOT become a Section', () => {
    const { nodes } = analyzeMarkdown(fixtures());
    const fromNotes = nodes.filter(
      (n) => n.type === NodeType.Section && n.file === 'notes.md',
    );
    expect(fromNotes).toHaveLength(1);
    expect(fromNotes[0].name).toBe('Plain');
    expect(nodes.some((n) => n.name.includes('fake heading'))).toBe(false);
  });
});

// ─── CONTAINS edges ──────────────────────────────────────────────

describe('analyzeMarkdown — CONTAINS edges', () => {
  it('emits Page CONTAINS Section for every section', () => {
    const { nodes, relationships } = analyzeMarkdown(fixtures());
    const sections = nodes.filter((n) => n.type === NodeType.Section);
    const contains = relationships.filter(
      (r) => r.type === RelationshipType.CONTAINS,
    );
    expect(contains).toHaveLength(sections.length);

    for (const section of sections) {
      const edge = contains.find((r) => r.targetId === section.id);
      expect(edge).toBeDefined();
      expect(edge!.sourceId).toBe(`md:page:${section.file}`);
    }
  });
});

// ─── searchText snapshot ─────────────────────────────────────────

describe('analyzeMarkdown — searchText snapshot', () => {
  it('returns a searchText entry for every prose node', () => {
    const { nodes, searchText } = analyzeMarkdown(fixtures());
    for (const node of nodes) {
      expect(searchText).toHaveProperty(node.id);
      expect(typeof searchText[node.id]).toBe('string');
    }
  });

  it('Section searchText is heading + the body beneath it', () => {
    const { nodes, searchText } = analyzeMarkdown(fixtures());
    const overview = nodes.find(
      (n) => n.type === NodeType.Section && n.name === 'Overview',
    )!;
    expect(searchText[overview.id]).toContain('Overview');
    expect(searchText[overview.id]).toContain('Overview body text');
    // Body beneath the *next* heading must not bleed into this section.
    expect(searchText[overview.id]).not.toContain('Setup instructions');
  });

  it('Page searchText carries the full body (the BM25 input lives here, not on the node)', () => {
    const { searchText } = analyzeMarkdown(fixtures());
    const pageText = searchText['md:page:docs/guide.md'];
    expect(pageText).toContain('Overview body text');
    expect(pageText).toContain('Setup instructions here');
  });
});

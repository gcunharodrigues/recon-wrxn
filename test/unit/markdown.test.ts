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

// ─── Control-char hardening ──────────────────────────────────────

// Heading/frontmatter text is copied verbatim into node.name. Raw C0 control
// chars / ANSI ESC (0x1b) in a .md would spoof a terminal when the name is
// printed. node.name must be stripped of C0 control characters (0x00–0x1F).
// The searchText body is left as-is (it is not surfaced as a label).
const C0_CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']');

describe('analyzeMarkdown — control-char hardening', () => {
  it('strips C0 control chars (incl. ESC) from a Section name', () => {
    // Heading text contains an ESC (0x1b) + an SGR color sequence.
    const md = '# Head' + String.fromCharCode(27) + '[31mING\nbody\n';
    const { nodes } = analyzeMarkdown([{ path: 'x.md', content: md }]);
    const section = nodes.find((n) => n.type === NodeType.Section)!;
    expect(C0_CONTROL.test(section.name)).toBe(false);
    expect(section.name).toContain('Head');
    expect(section.name).toContain('ING');
  });

  it('strips C0 control chars from a Page title (frontmatter)', () => {
    const md = '---\ntitle: Evil' + String.fromCharCode(27) + 'Title\n---\n# H\nbody\n';
    const { nodes } = analyzeMarkdown([{ path: 'y.md', content: md }]);
    const page = nodes.find((n) => n.type === NodeType.Page)!;
    expect(C0_CONTROL.test(page.name)).toBe(false);
    expect(page.name).toContain('Evil');
    expect(page.name).toContain('Title');
  });
});

// ─── Edge cases (behavior lock) ──────────────────────────────────

// Characterization tests: these cases already work by construction; the
// asserts lock the behavior so downstream slices can rely on it.
describe('analyzeMarkdown — edge cases', () => {
  it('a setext (underline) heading becomes a Section', () => {
    const md = ['Heading One', '===========', 'Body under setext.', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'setext.md', content: md }]);
    const sections = nodes.filter((n) => n.type === NodeType.Section);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Heading One');
  });

  it('a file with NO headings yields a Page with zero Sections', () => {
    const md = 'Just a paragraph, no headings at all.\n';
    const { nodes } = analyzeMarkdown([{ path: 'flat.md', content: md }]);
    const pages = nodes.filter((n) => n.type === NodeType.Page);
    const sections = nodes.filter((n) => n.type === NodeType.Section);
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('flat.md');
    expect(sections).toHaveLength(0);
  });

  it('an empty file yields a Page with zero Sections', () => {
    const { nodes } = analyzeMarkdown([{ path: 'empty.md', content: '' }]);
    const pages = nodes.filter((n) => n.type === NodeType.Page);
    const sections = nodes.filter((n) => n.type === NodeType.Section);
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('md:page:empty.md');
    expect(sections).toHaveLength(0);
  });

  it('a frontmatter-only file yields a Page with the title and zero Sections', () => {
    const md = ['---', 'title: Only Frontmatter', '---', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'fm.md', content: md }]);
    const pages = nodes.filter((n) => n.type === NodeType.Page);
    const sections = nodes.filter((n) => n.type === NodeType.Section);
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('Only Frontmatter');
    expect(sections).toHaveLength(0);
  });
});

// ─── Doc↔code signal extraction (recon-prose-analyzer-06) ─────────

// analyzeMarkdown now also harvests the two high-precision doc→code signals as
// RAW references (resolution to real code node ids happens later, in the edge
// resolver, which is the only component with the code graph):
//   • frontmatter `derived_from:` anchors — a node id, a path, or path#symbol
//   • `file.ext:line` citations in the prose body
// Each is reported as a DocCitation { sourceId: <pageId>, ref, kind }.
describe('analyzeMarkdown — derived_from anchors', () => {
  it('harvests a scalar derived_from path as an anchor citation on the page', () => {
    const md = ['---', 'derived_from: src/foo.ts', '---', '# H', 'body', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/a.md', content: md }]);
    expect(citations).toContainEqual({
      sourceId: 'md:page:docs/a.md',
      ref: 'src/foo.ts',
      kind: 'anchor',
    });
  });

  it('harvests an inline-list derived_from (paths AND graph node ids)', () => {
    // The documented convention: derived_from: [<path>, <node-id>]
    const md = ['---', 'derived_from: [src/auth/login.ts, ts:func:login]', '---', '# H', 'b', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/auth.md', content: md }]);
    const refs = citations.filter((c) => c.kind === 'anchor').map((c) => c.ref).sort();
    expect(refs).toEqual(['src/auth/login.ts', 'ts:func:login']);
    expect(citations.every((c) => c.sourceId === 'md:page:docs/auth.md')).toBe(true);
  });

  it('harvests a block-sequence derived_from and a path#symbol anchor', () => {
    const md = [
      '---',
      'derived_from:',
      '  - src/a.ts#alpha',
      '  - src/b.ts',
      '---',
      '# H',
      'body',
      '',
    ].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/blk.md', content: md }]);
    const refs = citations.filter((c) => c.kind === 'anchor').map((c) => c.ref).sort();
    expect(refs).toEqual(['src/a.ts#alpha', 'src/b.ts']);
  });

  it('a page with no derived_from yields no anchor citations', () => {
    const md = ['---', 'title: Plain', '---', '# H', 'body src/foo.ts as prose', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/p.md', content: md }]);
    expect(citations.filter((c) => c.kind === 'anchor')).toHaveLength(0);
  });
});

describe('analyzeMarkdown — file:line citations', () => {
  it('harvests a `file.ext:line` citation from the prose body', () => {
    const md = ['# Heading', 'See `src/auth/token.ts:42` for the check.', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/c.md', content: md }]);
    expect(citations).toContainEqual({
      sourceId: 'md:page:docs/c.md',
      ref: 'src/auth/token.ts:42',
      kind: 'citation',
    });
  });

  it('does NOT harvest a citation from inside a fenced code block (example code)', () => {
    const md = ['# H', '```sh', 'recon explain --file src/x.ts:99', '```', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/fence.md', content: md }]);
    expect(citations.filter((c) => c.kind === 'citation')).toHaveLength(0);
  });

  it('a body with no file:line reference yields no citations', () => {
    const md = ['# H', 'Just narrative prose, nothing cited.', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/none.md', content: md }]);
    expect(citations).toHaveLength(0);
  });
});

// ─── synced_to watermark (sync-01) ───────────────────────────────

// A derived page may declare the source version it was last reconciled against
// as a `synced_to: <fingerprint>` frontmatter watermark — parsed alongside
// `derived_from`, carried as an OPAQUE string on the Page node. R1 stores +
// exposes whatever string is in frontmatter; no fingerprint computation, no
// drift compare (sync-02/03).
describe('analyzeMarkdown — synced_to watermark', () => {
  it('carries a synced_to frontmatter watermark on the Page node', () => {
    const md = ['---', 'synced_to: ast:abc123', '---', '# H', 'body', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'docs/w.md', content: md }]);
    const page = nodes.find((n) => n.id === 'md:page:docs/w.md')!;
    expect(page.syncedTo).toBe('ast:abc123');
  });

  it('keeps the watermark an opaque string (a path#symbol@sha value is stored verbatim)', () => {
    const md = ['---', 'synced_to: src/a.ts#login@deadbeef', '---', '# H', 'b', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'docs/v.md', content: md }]);
    const page = nodes.find((n) => n.id === 'md:page:docs/v.md')!;
    expect(page.syncedTo).toBe('src/a.ts#login@deadbeef');
  });

  it('puts the watermark on the Page, not on its Sections', () => {
    const md = ['---', 'synced_to: ast:xyz', '---', '# H', 'b', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'docs/s.md', content: md }]);
    const section = nodes.find((n) => n.type === NodeType.Section)!;
    expect('syncedTo' in section).toBe(false);
  });

  it('a page with no synced_to has no watermark (absent, not defaulted — no throw)', () => {
    const md = ['---', 'title: Plain', '---', '# H', 'body', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'docs/p.md', content: md }]);
    const page = nodes.find((n) => n.id === 'md:page:docs/p.md')!;
    expect('syncedTo' in page).toBe(false);
  });

  it('watermark and derived_from coexist (the watermark does not disturb anchor harvest)', () => {
    const md = ['---', 'derived_from: src/foo.ts', 'synced_to: ast:abc', '---', '# H', 'b', ''].join('\n');
    const { nodes, citations } = analyzeMarkdown([{ path: 'docs/c.md', content: md }]);
    const page = nodes.find((n) => n.id === 'md:page:docs/c.md')!;
    expect(page.syncedTo).toBe('ast:abc');
    expect(citations).toContainEqual({
      sourceId: 'md:page:docs/c.md',
      ref: 'src/foo.ts',
      kind: 'anchor',
    });
  });

  it('strips C0 control chars (incl. ESC) from the synced_to watermark (parity with node.name)', () => {
    // The watermark surfaces in recon_explain / recon_drift output, so it must be
    // stripped just like node.name — an un-stripped ESC could spoof the terminal.
    const md = ['---', 'synced_to: ast:' + String.fromCharCode(27) + '[31mabc', '---', '# H', 'b', ''].join('\n');
    const { nodes } = analyzeMarkdown([{ path: 'docs/ctl.md', content: md }]);
    const page = nodes.find((n) => n.id === 'md:page:docs/ctl.md')!;
    expect(C0_CONTROL.test(page.syncedTo!)).toBe(false);
    expect(page.syncedTo).toContain('ast:');
    expect(page.syncedTo).toContain('abc');
  });
});

// ─── Citation harvest is bounded (ReDoS guard) ───────────────────
// CITATION_RE backtracks quadratically on a long alphanumeric run with no
// terminating `:<digit>` (measured: 64k ≈ 4.6s, 1MB > 120s). Run via matchAll on
// every prose block, a single ≤1MB .md could hang `index` / `serve` auto-index /
// the watcher (availability DoS) — and the per-file try/catch catches throws, not
// hangs. The harvest is now bounded per whitespace-delimited token, so a
// pathological token is skipped while every real (short, whitespace-free) citation
// is still extracted.
describe('analyzeMarkdown — citation harvest is bounded (ReDoS guard)', () => {
  it('a pathological token returns fast AND a normal citation beside it is still extracted', () => {
    const huge = 'a'.repeat(200_000); // no ":<digit>" → quadratic backtrack pre-fix (~tens of s)
    const md = ['# H', `See src/auth.ts:42 then ${huge} done.`, ''].join('\n');
    const start = Date.now();
    const { citations } = analyzeMarkdown([{ path: 'docs/big.md', content: md }]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // post-fix: a few ms (measured ~50ms; 1MB ~120ms)
    expect(citations).toContainEqual({
      sourceId: 'md:page:docs/big.md',
      ref: 'src/auth.ts:42',
      kind: 'citation',
    });
  });

  it('still harvests a normal `src/auth.ts:42` citation (no real citation dropped)', () => {
    const md = ['# H', 'Ref `src/auth.ts:42` and also lib/x.ts:7 here.', ''].join('\n');
    const { citations } = analyzeMarkdown([{ path: 'docs/n.md', content: md }]);
    const refs = citations.filter((c) => c.kind === 'citation').map((c) => c.ref).sort();
    expect(refs).toEqual(['lib/x.ts:7', 'src/auth.ts:42']);
  });
});

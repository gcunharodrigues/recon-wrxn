/**
 * Unit Tests: text-native + binary Source analyzer (analyzeSource)
 *
 * Slice multiformat-distill-01. Mirrors the markdown analyzer shape: a pure
 * function over in-memory SourceFile fixtures → Source nodes + a searchText
 * snapshot (body kept OFF the node). HTML is stripped to readable text; .txt is
 * whole-file; binary (pdf/docx/pptx/xlsx) yields a minimal node (path, no body,
 * no parse). Asserts external behavior, never internals — mirrors markdown.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../../src/analyzers/source.js';
import type { SourceFile } from '../../src/analyzers/source.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { isProseType } from '../../src/mcp/rules.js';
import { isEmbeddable, generateEmbeddingText, shouldEmbed } from '../../src/search/text-generator.js';

const HTML = [
  '<!DOCTYPE html>',
  '<html><head><title>ignored</title>',
  '<style>.a{color:red}</style></head>',
  '<body>',
  '<h1>Quantum Computing</h1>',
  '<p>Qubits &amp; gates explained.</p>',
  '<script>var secret = 1;</script>',
  '</body></html>',
].join('\n');

function textNativeFixtures(): SourceFile[] {
  return [
    { path: 'docs/page.html', kind: 'text', ext: '.html', content: HTML },
    { path: 'notes/raw.txt', kind: 'text', ext: '.txt', content: 'Plain text body here.\nSecond line.\n' },
  ];
}

// ─── Text-native: .html ──────────────────────────────────────────

describe('analyzeSource — .html', () => {
  it('emits one Source node per html file with exported:false', () => {
    const { nodes } = analyzeSource(textNativeFixtures());
    const html = nodes.find((n) => n.file === 'docs/page.html')!;
    expect(html).toBeDefined();
    expect(html.type).toBe(NodeType.Source);
    expect(html.exported).toBe(false);
    expect(html.language).toBe(Language.Html);
    expect(html.id).toBe('source:docs/page.html');
    expect(html.name).toBe('page.html');
  });

  it('strips tags — searchText is readable text, not markup', () => {
    const { searchText } = analyzeSource(textNativeFixtures());
    const body = searchText['source:docs/page.html'];
    expect(body).toBeDefined();
    expect(body).toContain('Quantum Computing');
    expect(body).toContain('Qubits & gates explained.'); // entity decoded
    // markup + script/style content stripped
    expect(body).not.toContain('<h1>');
    expect(body).not.toContain('var secret');
    expect(body).not.toContain('color:red');
  });
});

// ─── Text-native: .txt ───────────────────────────────────────────

describe('analyzeSource — .txt', () => {
  it('emits a Source node and carries the whole file as searchText', () => {
    const { nodes, searchText } = analyzeSource(textNativeFixtures());
    const txt = nodes.find((n) => n.file === 'notes/raw.txt')!;
    expect(txt.type).toBe(NodeType.Source);
    expect(txt.language).toBe(Language.Text);
    const body = searchText['source:notes/raw.txt'];
    expect(body).toContain('Plain text body here.');
    expect(body).toContain('Second line.');
  });
});

// ─── Binary: minimal node ────────────────────────────────────────

describe('analyzeSource — binary (pdf/docx/pptx/xlsx)', () => {
  it('emits a minimal Source node (path + filename, NO body, no searchText entry)', () => {
    const files: SourceFile[] = [
      { path: 'papers/study.pdf', kind: 'binary', ext: '.pdf' },
      { path: 'reports/q3.docx', kind: 'binary', ext: '.docx' },
    ];
    const { nodes, searchText } = analyzeSource(files);

    const pdf = nodes.find((n) => n.file === 'papers/study.pdf')!;
    expect(pdf.type).toBe(NodeType.Source);
    expect(pdf.exported).toBe(false);
    expect(pdf.name).toBe('study.pdf');
    expect(pdf.language).toBe(Language.Pdf);
    // No body was parsed → no searchText entry for binary nodes.
    expect(searchText['source:papers/study.pdf']).toBeUndefined();
    expect(searchText['source:reports/q3.docx']).toBeUndefined();
    expect(nodes.find((n) => n.file === 'reports/q3.docx')!.language).toBe(Language.Docx);
  });
});

// ─── Per-file isolation ──────────────────────────────────────────

describe('analyzeSource — per-file parse isolation', () => {
  it('skips a malformed file (records a warning) and keeps the others', () => {
    const files: SourceFile[] = [
      { path: 'good-before.txt', kind: 'text', ext: '.txt', content: 'before body' },
      // content is not a string → string ops throw inside the per-file body
      { path: 'bad.html', kind: 'text', ext: '.html', content: 12345 as unknown as string },
      { path: 'good-after.txt', kind: 'text', ext: '.txt', content: 'after body' },
    ];

    const result = analyzeSource(files);

    const files2 = result.nodes.map((n) => n.file).sort();
    expect(files2).toEqual(['good-after.txt', 'good-before.txt']);
    // the bad file contributes NOTHING (atomic skip)
    expect(result.nodes.some((n) => n.file === 'bad.html')).toBe(false);
    // ...but it is surfaced as a warning
    expect(result.warnings.map((w) => w.file)).toContain('bad.html');
  });
});

// ─── Type-gate: BOTH sites (rules + text-generator) ──────────────

function sourceNode(id: string, body = ''): Node {
  return {
    id, type: NodeType.Source, name: 'page.html', file: 'docs/page.html',
    startLine: 1, endLine: 1, language: Language.Html, package: 'docs', exported: false,
  };
}

describe('Source type-gate', () => {
  it('rules.ts isProseType classifies Source as prose (kept out of code-only analyses)', () => {
    expect(isProseType(NodeType.Source)).toBe(true);
  });

  it('text-generator treats Source as embeddable prose — takes the body path, not a code signature', () => {
    const node = sourceNode('source:docs/page.html');
    expect(isEmbeddable(node)).toBe(true);
    const text = generateEmbeddingText(node, 'Quantum computing body text.');
    // prose path: name + body, NOT the "Source: name / File: ..." code signature
    expect(text).toBe('page.html\nQuantum computing body text.');
    expect(text).not.toContain('File:');
  });
});

// ─── Embedding gate: binary Source nodes carry no vector ─────────
// A binary Source node (pdf/docx/…) has only a filename — no parsed body. It is
// type-embeddable, but embedding its filename adds a noise vector, not meaning
// (PRD: binary = minimal node; searchable content arrives via the distilled page).
// shouldEmbed is the gate the index embed loop uses to decide what gets a vector.

describe('Source embedding gate — shouldEmbed', () => {
  it('a binary Source node (no body) is NOT embedded, though its TYPE is eligible', () => {
    const node = sourceNode('source:papers/study.pdf');
    expect(isEmbeddable(node)).toBe(true); // type-eligible
    expect(shouldEmbed(node, undefined)).toBe(false); // ...but no body → no vector
    expect(shouldEmbed(node, '')).toBe(false);
    expect(shouldEmbed(node, '   ')).toBe(false); // whitespace-only is empty too
  });

  it('a text-native Source node (with body) IS embedded', () => {
    const node = sourceNode('source:docs/page.html');
    expect(shouldEmbed(node, 'Quantum computing body text.')).toBe(true);
  });
});

// ─── stripHtml is linear (ReDoS guard) ───────────────────────────
// The old <script>/<style> scrubber `/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi`
// is O(n²): an unclosed <script> makes the lazy `[\s\S]*?` scan to end-of-string
// from each of O(n) start positions. Measured: ~990 KB unclosed-<script> ≈ 28 s — an
// availability DoS, and the per-file try/catch catches throws, not hangs. The
// scrubber is now a single-pass indexOf scan (no backtracking).

describe('analyzeSource — stripHtml is linear (ReDoS guard)', () => {
  it('an adversarial ~1 MB unclosed-<script> input strips fast AND drops the script content', () => {
    const huge = '<script>leakedsecret '.repeat(50_000); // ~1 MB, never closed
    const html = `<h1>Visible Heading</h1>${huge}`;
    const file: SourceFile = { path: 'docs/evil.html', kind: 'text', ext: '.html', content: html };

    const start = Date.now();
    const { searchText } = analyzeSource([file]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // pre-fix: ~28 s of O(n²) backtrack
    const body = searchText['source:docs/evil.html'] ?? '';
    expect(body).toContain('Visible Heading'); // real prose survives
    expect(body).not.toContain('leakedsecret'); // unclosed-script content removed
  });
});

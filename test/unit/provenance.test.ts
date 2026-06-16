/**
 * Unit Tests: provenance loop — distilled wiki page → raw Source node
 * (multiformat-distill-07).
 *
 * A distilled wiki page carries `derived_from: <raw path>`. That anchor must
 * resolve to the raw `Source` node created by the M analyzers (slices 01/02),
 * INCLUDING a minimal binary node (e.g. a .pdf), producing the DOCUMENTED_BY
 * edge. recon_explain must show the link in BOTH directions, and recon_impact
 * BFS must NOT traverse the provenance edge.
 *
 * Two resolver extensions are exercised here (over recon-prose-analyzer-06):
 *   1. resolveAnchor's bare-path branch resolves a `derived_from:` path to the
 *      `source:<relpath>` Source node (not just NodeType.File).
 *   2. resolveCitation EXCLUDES Source — a Source carries a non-Markdown
 *      Language so it lands in the by-file map, but a `file:line` citation must
 *      never land on it.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { analyzeMarkdown } from '../../src/analyzers/markdown.js';
import type { DocCitation } from '../../src/analyzers/markdown.js';
import { resolveDocEdges } from '../../src/analyzers/doc-edges.js';
import { handleToolCall } from '../../src/mcp/handlers.js';

// ─── Source-node fixtures (slice 01 id scheme: `source:<relpath>`) ──────────

/** A text-native Source node (html/txt/yaml/json) — body parsed off the node. */
function textSource(rel: string, language: Language, lastLine: number): Node {
  return {
    id: `source:${rel}`,
    type: NodeType.Source,
    name: rel.split('/').pop()!,
    file: rel,
    startLine: 1,
    endLine: lastLine,
    language,
    package: '.wrxn/raw',
    exported: false,
  };
}

/** A minimal binary Source node (pdf/docx/pptx/xlsx) — path only, lines 1..1. */
function binarySource(rel: string, language: Language): Node {
  return { ...textSource(rel, language, 1) };
}

const cite = (
  ref: string,
  kind: DocCitation['kind'],
  sourceId = 'md:page:.wrxn/wiki/concepts/paper.md',
): DocCitation => ({ sourceId, ref, kind });

// ─── 1. resolveAnchor extension: bare path → Source node ────────────────────

describe('provenance — derived_from resolves to a Source node', () => {
  it('resolves a bare-path anchor to a text-native Source node', () => {
    const g = new KnowledgeGraph();
    g.addNode(textSource('.wrxn/raw/guide.html', Language.Html, 42));
    const edges = resolveDocEdges(g, [cite('.wrxn/raw/guide.html', 'anchor')]);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe(RelationshipType.DOCUMENTED_BY);
    expect(edges[0].targetId).toBe('source:.wrxn/raw/guide.html');
  });

  it('resolves a bare-path anchor to a MINIMAL BINARY Source node (.pdf)', () => {
    const g = new KnowledgeGraph();
    g.addNode(binarySource('.wrxn/raw/paper.pdf', Language.Pdf));
    const edges = resolveDocEdges(g, [cite('.wrxn/raw/paper.pdf', 'anchor')]);
    expect(edges.map((e) => e.targetId)).toEqual(['source:.wrxn/raw/paper.pdf']);
  });

  it('tolerates a ./-prefixed derived_from path', () => {
    const g = new KnowledgeGraph();
    g.addNode(binarySource('.wrxn/raw/paper.pdf', Language.Pdf));
    const edges = resolveDocEdges(g, [cite('./.wrxn/raw/paper.pdf', 'anchor')]);
    expect(edges.map((e) => e.targetId)).toEqual(['source:.wrxn/raw/paper.pdf']);
  });
});

// ─── 2. resolveCitation extension: Source excluded ──────────────────────────

describe('provenance — resolveCitation never lands on a Source node', () => {
  it('a file:line citation whose line falls in a Source range creates NO edge', () => {
    // A binary Source spans lines 1..1; line 1 would be "contained" — but a
    // Source is not code, so the citation must resolve to nothing.
    const g = new KnowledgeGraph();
    g.addNode(binarySource('.wrxn/raw/paper.pdf', Language.Pdf));
    const edges = resolveDocEdges(g, [cite('.wrxn/raw/paper.pdf:1', 'citation')]);
    expect(edges).toHaveLength(0);
  });

  it('a file:line citation into a text-native Source range creates NO edge', () => {
    const g = new KnowledgeGraph();
    g.addNode(textSource('.wrxn/raw/guide.html', Language.Html, 42));
    const edges = resolveDocEdges(g, [cite('.wrxn/raw/guide.html:10', 'citation')]);
    expect(edges).toHaveLength(0);
  });
});

// ─── 3. Full chain: analyzeMarkdown(distilled page) → resolver → edge ───────

describe('provenance — distilled page derived_from → raw Source (full chain)', () => {
  it('a real distilled page resolves its derived_from to the raw Source node', () => {
    const g = new KnowledgeGraph();
    g.addNode(binarySource('.wrxn/raw/paper.pdf', Language.Pdf));

    const md = [
      '---',
      'title: Attention Distilled',
      'derived_from: .wrxn/raw/paper.pdf',
      '---',
      '# Summary',
      'A distillation of the source paper.',
      '',
    ].join('\n');
    const result = analyzeMarkdown([{ path: '.wrxn/wiki/concepts/paper.md', content: md }]);
    for (const n of result.nodes) g.addNode(n);
    for (const r of result.relationships) g.addRelationship(r);
    const edges = resolveDocEdges(g, result.citations);

    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe(RelationshipType.DOCUMENTED_BY);
    expect(edges[0].sourceId).toBe('md:page:.wrxn/wiki/concepts/paper.md');
    expect(edges[0].targetId).toBe('source:.wrxn/raw/paper.pdf');
  });
});

// ─── 4. recon_explain — both directions ─────────────────────────────────────

/** Build a wired graph: distilled Page -DOCUMENTED_BY-> raw Source. */
function provenanceGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(binarySource('.wrxn/raw/paper.pdf', Language.Pdf));
  g.addNode({
    id: 'md:page:.wrxn/wiki/concepts/paper.md',
    type: NodeType.Page,
    name: 'Attention Distilled',
    file: '.wrxn/wiki/concepts/paper.md',
    startLine: 1,
    endLine: 7,
    language: Language.Markdown,
    package: '.wrxn/wiki/concepts',
    exported: false,
  });
  const [edge] = resolveDocEdges(g, [
    cite('.wrxn/raw/paper.pdf', 'anchor', 'md:page:.wrxn/wiki/concepts/paper.md'),
  ]);
  g.addRelationship(edge);
  return g;
}

describe('provenance — recon_explain shows the link both directions', () => {
  it('on the distilled page: shows the raw source it documents', async () => {
    const out = await handleToolCall('recon_explain', { name: 'Attention Distilled' }, provenanceGraph());
    expect(out).toContain('Documents');
    expect(out).toContain('paper.pdf');
    expect(out).toContain('DOCUMENTED_BY');
  });

  it('on the raw source: shows the documenting distilled page', async () => {
    const out = await handleToolCall('recon_explain', { name: 'paper.pdf' }, provenanceGraph());
    expect(out).toContain('Documented By');
    expect(out).toContain('Attention Distilled');
    expect(out).toContain('DOCUMENTED_BY');
  });
});

// ─── 5. recon_impact — does NOT traverse the provenance edge ────────────────

describe('provenance — recon_impact BFS skips the DOCUMENTED_BY edge', () => {
  it('impact upstream on the raw source does not surface the documenting page', async () => {
    const out = await handleToolCall(
      'recon_impact',
      { target: 'paper.pdf', direction: 'upstream' },
      provenanceGraph(),
    );
    // The only incoming edge is Page -DOCUMENTED_BY-> Source; it must be skipped,
    // so the documenting page is never in the blast radius.
    expect(out).not.toContain('Attention Distilled');
    expect(out).toContain('**Summary:** 0 direct callers');
  });
});

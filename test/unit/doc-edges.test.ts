/**
 * Unit Tests: doc↔code edge resolver (recon-prose-analyzer-06)
 *
 * resolveDocEdges turns the RAW doc→code signals harvested by analyzeMarkdown
 * (frontmatter `derived_from:` anchors + `file.ext:line` body citations) into
 * DOCUMENTED_BY relationships against the live code graph. Precision-first:
 *   • anchor  = a node id, a path (→ File node), or path#symbol (→ that symbol)
 *   • citation = file:line (→ the innermost code symbol whose range holds line)
 *   • an unresolvable signal creates NO edge (a wrong edge misleads worse than a
 *     missing one); NO fuzzy symbol-name matching.
 *
 * DOCUMENTED_BY is directed Prose → Code: sourceId = Page, targetId = symbol.
 */
import { describe, it, expect } from 'vitest';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { analyzeMarkdown } from '../../src/analyzers/markdown.js';
import type { DocCitation } from '../../src/analyzers/markdown.js';
import { resolveDocEdges } from '../../src/analyzers/doc-edges.js';

// ─── A small code graph (no prose) ──────────────────────────────

function codeNode(id: string, name: string, o: Partial<Node>): Node {
  return {
    id, type: NodeType.Function, name,
    file: 'src/x.ts', startLine: 1, endLine: 10,
    language: Language.TypeScript, package: 'src', exported: true,
    ...o,
  };
}

function buildCodeGraph(): KnowledgeGraph {
  const g = new KnowledgeGraph();
  // a File node for bare-path anchors
  g.addNode(codeNode('ts:file:src/auth/login.ts', 'login.ts', {
    type: NodeType.File, file: 'src/auth/login.ts', startLine: 0, endLine: 0, package: 'src/auth',
  }));
  // an exported symbol in that file, lines 5-20
  g.addNode(codeNode('ts:func:login', 'login', {
    file: 'src/auth/login.ts', startLine: 5, endLine: 20, package: 'src/auth',
  }));
  // a nested/inner symbol 8-12 (tighter range → wins line-containment ties)
  g.addNode(codeNode('ts:func:validate', 'validate', {
    file: 'src/auth/login.ts', startLine: 8, endLine: 12, package: 'src/auth',
  }));
  // a different file: its File node (for bare-path anchors) + a symbol
  g.addNode(codeNode('ts:file:src/auth/token.ts', 'token.ts', {
    type: NodeType.File, file: 'src/auth/token.ts', startLine: 0, endLine: 0, package: 'src/auth',
  }));
  g.addNode(codeNode('ts:func:token', 'issueToken', {
    file: 'src/auth/token.ts', startLine: 3, endLine: 30, package: 'src/auth',
  }));
  return g;
}

const cite = (ref: string, kind: DocCitation['kind'], sourceId = 'md:page:docs/d.md'): DocCitation =>
  ({ sourceId, ref, kind });

// ─── Confidence: doc-asserted, not code-verified (P1.5-D) ────────

describe('resolveDocEdges — confidence reflects doc-asserted (unverified) provenance', () => {
  it('a derived_from anchor outranks an incidental body citation, and NEITHER is a verified 1.0 edge', () => {
    const g = buildCodeGraph();
    const [anchorEdge] = resolveDocEdges(g, [cite('ts:func:login', 'anchor')]);
    const [citeEdge] = resolveDocEdges(g, [cite('src/auth/login.ts:10', 'citation')]);
    expect(anchorEdge.confidence).toBe(0.9);
    expect(citeEdge.confidence).toBe(0.5);
    // The code side never confirms a doc's claim → no DOCUMENTED_BY edge is verified.
    expect(anchorEdge.confidence).toBeLessThan(1.0);
    expect(citeEdge.confidence).toBeLessThan(anchorEdge.confidence);
  });
});

// ─── Anchor resolution ──────────────────────────────────────────

describe('resolveDocEdges — derived_from anchors', () => {
  it('resolves a direct graph node id to a DOCUMENTED_BY edge (Page → symbol)', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('ts:func:login', 'anchor')]);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe(RelationshipType.DOCUMENTED_BY);
    expect(edges[0].sourceId).toBe('md:page:docs/d.md');
    expect(edges[0].targetId).toBe('ts:func:login');
  });

  it('resolves path#symbol to the named symbol in that file', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts#login', 'anchor')]);
    expect(edges.map((e) => e.targetId)).toEqual(['ts:func:login']);
  });

  it('tolerates a trailing @sha provenance watermark on a path#symbol anchor', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts#login@abc123', 'anchor')]);
    expect(edges.map((e) => e.targetId)).toEqual(['ts:func:login']);
  });

  it('resolves a bare path to the File node', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts', 'anchor')]);
    expect(edges.map((e) => e.targetId)).toEqual(['ts:file:src/auth/login.ts']);
  });

  it('an anchor whose path#symbol does not exist creates NO edge', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts#ghost', 'anchor')]);
    expect(edges).toHaveLength(0);
  });

  it('an anchor to an unknown file creates NO edge', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/nope/missing.ts', 'anchor')]);
    expect(edges).toHaveLength(0);
  });
});

// ─── Citation resolution ────────────────────────────────────────

describe('resolveDocEdges — file:line citations', () => {
  it('resolves file:line to the innermost code symbol whose range holds the line', () => {
    // line 10 is inside login (5-20) AND validate (8-12) → tighter validate wins
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts:10', 'citation')]);
    expect(edges.map((e) => e.targetId)).toEqual(['ts:func:validate']);
  });

  it('resolves file:line that only one symbol holds', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts:18', 'citation')]);
    expect(edges.map((e) => e.targetId)).toEqual(['ts:func:login']);
  });

  it('a citation to a line outside every symbol range creates NO edge (no File-node fallback)', () => {
    // line 2 precedes login (starts 5); the File node is 0/0 and must not match
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/auth/login.ts:2', 'citation')]);
    expect(edges).toHaveLength(0);
  });

  it('a citation to an unknown file creates NO edge', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [cite('src/unknown.ts:5', 'citation')]);
    expect(edges).toHaveLength(0);
  });
});

// ─── Precision guarantees ───────────────────────────────────────

describe('resolveDocEdges — precision guarantees', () => {
  it('never matches a code symbol by name alone (no fuzzy-name edges)', () => {
    // "login" is a real exported symbol, but a bare name is neither a path,
    // a path#symbol, nor a node id → it must NOT resolve.
    const edges = resolveDocEdges(buildCodeGraph(), [cite('login', 'anchor')]);
    expect(edges).toHaveLength(0);
  });

  it('never links prose → prose (a .md target is excluded)', () => {
    const g = buildCodeGraph();
    g.addNode(codeNode('md:page:docs/other.md', 'Other', {
      type: NodeType.Page, file: 'docs/other.md', language: Language.Markdown, exported: false,
    }));
    const edges = resolveDocEdges(g, [cite('docs/other.md', 'anchor')]);
    expect(edges).toHaveLength(0);
  });

  it('deduplicates: an anchor and a citation to the same target yield ONE edge', () => {
    const edges = resolveDocEdges(buildCodeGraph(), [
      cite('ts:func:login', 'anchor'),
      cite('src/auth/login.ts:18', 'citation'),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('ts:func:login');
  });
});

// ─── Full chain: markdown → resolver (the AC integration) ────────

describe('doc↔code edges — analyzeMarkdown → resolveDocEdges', () => {
  it('a real .md page with derived_from + a body citation produces edges to real code nodes', () => {
    const g = buildCodeGraph();
    const md = [
      '---',
      'title: Auth Concept Guide',
      'derived_from: [src/auth/login.ts#login, src/auth/token.ts]',
      '---',
      '# Overview',
      'The validator lives at `src/auth/login.ts:10`.',
      '',
    ].join('\n');
    const result = analyzeMarkdown([{ path: 'docs/auth-guide.md', content: md }]);
    for (const n of result.nodes) g.addNode(n);
    for (const r of result.relationships) g.addRelationship(r);
    const edges = resolveDocEdges(g, result.citations);

    const targets = new Set(edges.map((e) => e.targetId));
    expect(targets.has('ts:func:login')).toBe(true);              // path#symbol anchor → symbol
    expect(targets.has('ts:file:src/auth/token.ts')).toBe(true);  // bare path anchor → File node
    expect(targets.has('ts:func:validate')).toBe(true);           // body citation line 10 → innermost
    expect(targets.has('ts:func:token')).toBe(false);             // bare path resolves to File, not the symbol
    // every edge is Page → code, typed DOCUMENTED_BY
    for (const e of edges) {
      expect(e.type).toBe(RelationshipType.DOCUMENTED_BY);
      expect(e.sourceId).toBe('md:page:docs/auth-guide.md');
    }
  });
});

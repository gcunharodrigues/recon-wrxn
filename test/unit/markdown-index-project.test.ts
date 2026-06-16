/**
 * Unit Tests: prose ingestion on the multi-repo `recon index <dir>` path.
 *
 * indexCommand (the primary `recon index`) ingests prose, but indexProject
 * (the secondary external-repo path) must ALSO ingest prose — otherwise
 * secondary repos get zero Page/Section nodes and no search-text.json. This
 * runs the real indexProject over a temp fixture dir and asserts the saved
 * external-repo index gained prose nodes + a search-text.json snapshot.
 *
 * Temp-dir style mirrors markdown-index.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexProject } from '../../src/cli/commands.js';
import { loadIndex, loadSearchText } from '../../src/storage/store.js';
import { NodeType, RelationshipType } from '../../src/graph/types.js';

const REPO = 'extrepo';
let extDir: string;
let mainRoot: string;

beforeAll(() => {
  extDir = mkdtempSync(join(tmpdir(), 'recon-ext-'));
  mainRoot = mkdtempSync(join(tmpdir(), 'recon-main-'));
  mkdirSync(join(extDir, 'docs'), { recursive: true });
  mkdirSync(join(extDir, 'lib'), { recursive: true });
  // A code file the guide's frontmatter anchor will link to (recon-prose-analyzer-06).
  writeFileSync(
    join(extDir, 'lib', 'auth.ts'),
    'export function validateToken(token: string): boolean {\n  return token.length > 0;\n}\n',
  );
  writeFileSync(join(extDir, 'README.md'), '# Ext Readme\nExternal readme body.\n');
  writeFileSync(
    join(extDir, 'docs', 'guide.md'),
    '---\ntitle: Ext Guide\nderived_from: lib/auth.ts#validateToken\n---\n# Guide\nGuide body.\n\n## Details\nDetail text.\n',
  );
  // Multi-format Source files (multiformat-distill-01): a text-native .html and
  // a minimal binary .pdf, ingested at the SAME seam as prose.
  writeFileSync(
    join(extDir, 'docs', 'spec.html'),
    '<html><body><h1>Spec</h1><p>Photosynthesis overview.</p></body></html>',
  );
  writeFileSync(join(extDir, 'docs', 'paper.pdf'), '%PDF-1.4 binary bytes');
});

afterAll(() => {
  rmSync(extDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

describe('indexProject ingests prose for secondary repos', () => {
  it('saves Page and Section nodes into the external-repo graph', async () => {
    await indexProject(extDir, mainRoot, REPO);

    const stored = await loadIndex(mainRoot, REPO);
    expect(stored).not.toBeNull();
    const nodes = [...stored!.graph.nodes.values()];
    const pages = nodes.filter((n) => n.type === NodeType.Page);
    const sections = nodes.filter((n) => n.type === NodeType.Section);

    // 2 pages (README, guide); guide has 2 sections (Guide, Details).
    expect(pages.length).toBe(2);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(stored!.graph.getNode('md:page:docs/guide.md')).toBeDefined();
  });

  it('writes a search-text.json snapshot under the external repo dir', async () => {
    await indexProject(extDir, mainRoot, REPO);

    expect(
      existsSync(join(mainRoot, '.recon-wrxn', 'repos', REPO, 'search-text.json')),
    ).toBe(true);

    const snapshot = await loadSearchText(mainRoot, REPO);
    expect(snapshot).not.toBeNull();
    expect(snapshot!['md:page:docs/guide.md']).toContain('Guide body.');
  });

  it('ingests Source nodes (html text-native + minimal binary) at the prose seam', async () => {
    await indexProject(extDir, mainRoot, REPO);

    const stored = await loadIndex(mainRoot, REPO);
    expect(stored).not.toBeNull();

    // text-native .html → full Source node, body in the snapshot (tags stripped).
    const html = stored!.graph.getNode('source:docs/spec.html');
    expect(html?.type).toBe(NodeType.Source);
    expect(html?.exported).toBe(false);
    const snapshot = await loadSearchText(mainRoot, REPO);
    expect(snapshot!['source:docs/spec.html']).toContain('Photosynthesis overview.');
    expect(snapshot!['source:docs/spec.html']).not.toContain('<h1>');

    // binary .pdf → minimal Source node, NO snapshot entry.
    const pdf = stored!.graph.getNode('source:docs/paper.pdf');
    expect(pdf?.type).toBe(NodeType.Source);
    expect(snapshot!['source:docs/paper.pdf']).toBeUndefined();
  });

  it('resolves a derived_from anchor into a DOCUMENTED_BY edge to real code', async () => {
    await indexProject(extDir, mainRoot, REPO);

    const stored = await loadIndex(mainRoot, REPO);
    expect(stored).not.toBeNull();

    const docEdges = [...stored!.graph.relationships.values()].filter(
      (r) => r.type === RelationshipType.DOCUMENTED_BY,
    );
    // The guide frontmatter anchor links the page to the validateToken symbol.
    expect(docEdges).toHaveLength(1);
    expect(docEdges[0].sourceId).toBe('md:page:docs/guide.md');
    const target = stored!.graph.getNode(docEdges[0].targetId);
    expect(target?.name).toBe('validateToken');
    expect(target?.file).toBe('lib/auth.ts');
  });
});

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
import { NodeType } from '../../src/graph/types.js';

const REPO = 'extrepo';
let extDir: string;
let mainRoot: string;

beforeAll(() => {
  extDir = mkdtempSync(join(tmpdir(), 'recon-ext-'));
  mainRoot = mkdtempSync(join(tmpdir(), 'recon-main-'));
  mkdirSync(join(extDir, 'docs'), { recursive: true });
  writeFileSync(join(extDir, 'README.md'), '# Ext Readme\nExternal readme body.\n');
  writeFileSync(
    join(extDir, 'docs', 'guide.md'),
    '---\ntitle: Ext Guide\n---\n# Guide\nGuide body.\n\n## Details\nDetail text.\n',
  );
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
});

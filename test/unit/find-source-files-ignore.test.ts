/**
 * Unit Tests: findSourceFiles config.ignore pruning
 *
 * Verifies that path-prefix ignore patterns (from .recon.json `ignore`) prune
 * whole subtrees at the walk — the fix for worktree pollution (e.g. a
 * `projects/<slug>` worktree duplicating the parent's source into the graph).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSourceFiles } from '../../src/analyzers/tree-sitter/index.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recon-ignore-'));
  // src/app.ts            → kept
  // projects/site/dup.ts  → pruned by ignore ["projects"]
  // docs/legacy/old.ts    → pruned by ignore ["docs/legacy"]
  // docs/keep.ts          → kept (sibling of an ignored nested prefix)
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'projects', 'site'), { recursive: true });
  mkdirSync(join(root, 'docs', 'legacy'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'projects', 'site', 'dup.ts'), 'export const b = 2;\n');
  writeFileSync(join(root, 'docs', 'legacy', 'old.ts'), 'export const c = 3;\n');
  writeFileSync(join(root, 'docs', 'keep.ts'), 'export const d = 4;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findSourceFiles ignore pruning', () => {
  const rels = (ignore?: string[]) =>
    findSourceFiles(root, ignore).map((f) => f.relativePath).sort();

  it('indexes everything when no ignore patterns are given', () => {
    expect(rels()).toEqual([
      'docs/keep.ts',
      'docs/legacy/old.ts',
      'projects/site/dup.ts',
      'src/app.ts',
    ]);
  });

  it('prunes a top-level subtree by name', () => {
    expect(rels(['projects'])).toEqual([
      'docs/keep.ts',
      'docs/legacy/old.ts',
      'src/app.ts',
    ]);
  });

  it('prunes a nested-path prefix without touching its siblings', () => {
    expect(rels(['docs/legacy'])).toEqual([
      'docs/keep.ts',
      'projects/site/dup.ts',
      'src/app.ts',
    ]);
  });

  it('normalizes leading/trailing slashes in patterns', () => {
    expect(rels(['/projects/'])).toEqual([
      'docs/keep.ts',
      'docs/legacy/old.ts',
      'src/app.ts',
    ]);
  });

  it('does not prune on partial-segment matches', () => {
    // "project" must NOT match the "projects" directory
    expect(rels(['project'])).toEqual([
      'docs/keep.ts',
      'docs/legacy/old.ts',
      'projects/site/dup.ts',
      'src/app.ts',
    ]);
  });
});

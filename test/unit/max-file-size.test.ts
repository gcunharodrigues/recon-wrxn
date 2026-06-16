/**
 * Unit Tests: optional maxFileSize cap across all three walkers (multiformat-distill-04)
 *
 * Decision C: the hard 1 MB MAX_FILE_SIZE skip is REMOVED from every walker
 * (markdown/prose, multi-format source, tree-sitter code). The cap is now an
 * OPTIONAL `maxFileSize` config field that DEFAULTS to unlimited (no cap) — an
 * OOM escape hatch a user can set per-install in .recon-wrxn.json.
 *
 * Pins: (1) a >1 MB file is INDEXED (not skipped) by default in every walker;
 * (2) when maxFileSize is passed, files above it ARE skipped; (3) loadConfig
 * threads the field through.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findMarkdownFiles } from '../../src/analyzers/markdown.js';
import { findSourceFiles } from '../../src/analyzers/source.js';
import { findSourceFiles as findCodeFiles } from '../../src/analyzers/tree-sitter/index.js';
import { loadConfig } from '../../src/config/config.js';

const OVER_1MB = 1_000_001; // strictly larger than the old 1 MB hard cap

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recon-maxsize-'));
  // One >1 MB file per walker, plus a small sibling each, all syntactically valid.
  writeFileSync(join(root, 'big.md'), '# Heading\n\n' + 'word '.repeat(250_000)); // >1 MB
  writeFileSync(join(root, 'small.md'), '# Small\n\nbody.');
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(OVER_1MB));
  writeFileSync(join(root, 'small.txt'), 'tiny body.');
  // Valid Python so the tree-sitter walker has an available grammar to claim it.
  writeFileSync(join(root, 'big.py'), '# c\n' + 'x = 1\n'.repeat(170_000)); // >1 MB
  writeFileSync(join(root, 'small.py'), 'y = 2\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('markdown walker (findMarkdownFiles)', () => {
  it('indexes a >1 MB .md by default (no cap)', () => {
    const paths = findMarkdownFiles(root).map((f) => f.path).sort();
    expect(paths).toContain('big.md');
    expect(paths).toContain('small.md');
  });

  it('skips a file above maxFileSize when set, keeps smaller ones', () => {
    const paths = findMarkdownFiles(root, [], 500_000).map((f) => f.path);
    expect(paths).not.toContain('big.md');
    expect(paths).toContain('small.md');
  });
});

describe('source walker (findSourceFiles)', () => {
  it('indexes a >1 MB text-native source by default (no cap)', () => {
    const paths = findSourceFiles(root).map((f) => f.path).sort();
    expect(paths).toContain('big.txt');
    expect(paths).toContain('small.txt');
  });

  it('skips a text-native source above maxFileSize when set, keeps smaller ones', () => {
    const paths = findSourceFiles(root, [], 500_000).map((f) => f.path);
    expect(paths).not.toContain('big.txt');
    expect(paths).toContain('small.txt');
  });
});

describe('tree-sitter code walker (findSourceFiles)', () => {
  it('indexes a >1 MB code file by default (no cap)', () => {
    const paths = findCodeFiles(root).map((f) => f.relativePath).sort();
    expect(paths).toContain('big.py');
    expect(paths).toContain('small.py');
  });

  it('skips a code file above maxFileSize when set, keeps smaller ones', () => {
    const paths = findCodeFiles(root, [], 500_000).map((f) => f.relativePath);
    expect(paths).not.toContain('big.py');
    expect(paths).toContain('small.py');
  });
});

describe('config threading (loadConfig)', () => {
  it('reads maxFileSize from .recon-wrxn.json', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'recon-maxsize-cfg-'));
    writeFileSync(join(cfgDir, '.recon-wrxn.json'), JSON.stringify({ maxFileSize: 2_000_000 }));
    expect(loadConfig(cfgDir).maxFileSize).toBe(2_000_000);
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('defaults maxFileSize to Infinity (unlimited) when unset', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'recon-maxsize-def-'));
    expect(loadConfig(cfgDir).maxFileSize).toBe(Infinity);
    rmSync(cfgDir, { recursive: true, force: true });
  });
});

describe('config validation: maxFileSize footguns (loadConfig)', () => {
  // A non-positive or non-finite maxFileSize is meaningless as a byte cap:
  // 0 / negative would skip EVERY file (silent empty index); NaN/string would
  // silently ignore an intended cap. loadConfig coerces these to Infinity
  // (unlimited) and warns once, so neither footgun lands silently.
  const cases: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative', -5],
    ['non-numeric string', 'abc'],
  ];

  for (const [label, value] of cases) {
    it(`coerces ${label} maxFileSize to Infinity and warns`, () => {
      const cfgDir = mkdtempSync(join(tmpdir(), 'recon-maxsize-bad-'));
      writeFileSync(
        join(cfgDir, '.recon-wrxn.json'),
        JSON.stringify({ maxFileSize: value }),
      );
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(loadConfig(cfgDir).maxFileSize).toBe(Infinity);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
      rmSync(cfgDir, { recursive: true, force: true });
    });
  }
});

/**
 * Unit Tests: Source walker selectivity (multiformat-distill-03)
 *
 * The walker skips machine-generated NOISE — lockfiles (which slice 02 would
 * otherwise index as .json/.yaml Source nodes) and transient tool-dump dirs
 * (.playwright-mcp) — while STILL connecting everything the operator authored.
 * The indexer makes no "is this valuable" judgment: a normal authored .json /
 * .yml is kept; deciding something is dead is the harvest loop's job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSourceFiles } from '../../src/analyzers/source.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recon-selectivity-'));
  // Lockfiles — machine-generated, must be SKIPPED:
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, 'composer-lock.json'), '{"_readme":[]}'); // *-lock.json shape
  // yarn.lock needs NO rule — .lock is not a connected format (never indexed).
  writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  // Transient tool-dump dir — must NOT be walked:
  mkdirSync(join(root, '.playwright-mcp'), { recursive: true });
  writeFileSync(join(root, '.playwright-mcp', 'page-2026.json'), '{"snapshot":1}');
  writeFileSync(join(root, '.playwright-mcp', 'trace.yaml'), 'trace: dump\n');
  // Authored operator content — must be KEPT:
  writeFileSync(join(root, 'config.json'), '{"port":8080}');
  mkdirSync(join(root, 'docs', 'qa', 'gates'), { recursive: true });
  writeFileSync(join(root, 'docs', 'qa', 'gates', 'release.yml'), 'gate: green\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findSourceFiles selectivity', () => {
  const rels = () => findSourceFiles(root).map((f) => f.path).sort();

  it('skips lockfiles (package-lock.json / pnpm-lock.yaml / *-lock.json) and never indexes yarn.lock', () => {
    const paths = rels();
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('pnpm-lock.yaml');
    expect(paths).not.toContain('composer-lock.json');
    expect(paths).not.toContain('yarn.lock');
  });

  it('does not walk a .playwright-mcp transient dump dir', () => {
    expect(rels().some((p) => p.startsWith('.playwright-mcp/'))).toBe(false);
  });

  it('still indexes authored .json / .yml (selectivity does not over-reach)', () => {
    const paths = rels();
    expect(paths).toContain('config.json');
    expect(paths).toContain('docs/qa/gates/release.yml');
  });

  it('keeps ONLY the authored files', () => {
    expect(rels()).toEqual(['config.json', 'docs/qa/gates/release.yml']);
  });
});

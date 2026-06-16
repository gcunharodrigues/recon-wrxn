/**
 * Unit Tests: serve-time background embed (P1.5 slice C)
 *
 * Locks the PURE staleness decision (shouldServeEmbed) and the config surface
 * (serveEmbed default true, INIT_TEMPLATE, --no-serve-embed threaded via
 * mergeWithCLI). The detached spawn + fs.watch live-swap are integration glue,
 * verified by inspection — see the slice C report.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldServeEmbed } from '../../src/cli/commands.js';
import { loadConfig, mergeWithCLI, initConfig } from '../../src/config/config.js';

// ─── shouldServeEmbed (the 4 cases) ──────────────────────────────

describe('shouldServeEmbed', () => {
  it('absent embeddings (size null) → true', () => {
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: null, embeddableCount: 10 })).toBe(true);
  });

  it('incomplete embeddings (size < count) → true', () => {
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: 4, embeddableCount: 10 })).toBe(true);
  });

  it('complete embeddings (size >= count) → false', () => {
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: 10, embeddableCount: 10 })).toBe(false);
    expect(shouldServeEmbed({ serveEmbed: true, vectorStoreSize: 12, embeddableCount: 10 })).toBe(false);
  });

  it('serveEmbed disabled → false regardless of staleness', () => {
    expect(shouldServeEmbed({ serveEmbed: false, vectorStoreSize: null, embeddableCount: 10 })).toBe(false);
    expect(shouldServeEmbed({ serveEmbed: false, vectorStoreSize: 0, embeddableCount: 10 })).toBe(false);
  });
});

// ─── config: serveEmbed default + INIT_TEMPLATE + CLI opt-out ─────

describe('config serveEmbed', () => {
  it('defaults to true when no config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-serveembed-'));
    try {
      expect(loadConfig(dir).serveEmbed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects an explicit serveEmbed:false in .recon-wrxn.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-serveembed-'));
    try {
      writeFileSync(join(dir, '.recon-wrxn.json'), JSON.stringify({ serveEmbed: false }), 'utf-8');
      expect(loadConfig(dir).serveEmbed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initConfig writes serveEmbed:true into the template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-serveembed-'));
    try {
      expect(initConfig(dir)).toBe(true);
      expect(loadConfig(dir).serveEmbed).toBe(true);
      const raw = JSON.parse(readFileSync(join(dir, '.recon-wrxn.json'), 'utf-8'));
      expect(raw.serveEmbed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeWithCLI serveEmbed opt-out', () => {
  const base = loadConfig(mkdtempSync(join(tmpdir(), 'recon-serveembed-base-')));

  it('--no-serve-embed (serveEmbed:false) overrides to false', () => {
    expect(mergeWithCLI(base, { serveEmbed: false }).serveEmbed).toBe(false);
  });

  it('absent flag (commander default true) leaves config value intact', () => {
    // commander sets serveEmbed:true by default when only --no-serve-embed exists;
    // that benign true must NOT clobber a config-file serveEmbed:false.
    const cfgFalse = { ...base, serveEmbed: false };
    expect(mergeWithCLI(cfgFalse, { serveEmbed: true }).serveEmbed).toBe(false);
    expect(mergeWithCLI(cfgFalse, {}).serveEmbed).toBe(false);
  });

  it('default config (true) stays true when not opted out', () => {
    expect(mergeWithCLI(base, { serveEmbed: true }).serveEmbed).toBe(true);
    expect(mergeWithCLI(base, {}).serveEmbed).toBe(true);
  });
});

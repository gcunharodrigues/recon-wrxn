/**
 * R1b — runtime-surface rebrand: config filename, index dir, MCP server name.
 * Asserts the OBSERVABLE product-identity surfaces read `recon-wrxn`.
 * (Tool leaf-names keep the generic `recon_` prefix; `[recon]` log prefix is
 * generic — both deliberately retained per the R1b naming decision.)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadConfig, initConfig } from '../../src/config/config.js';
import { SERVER_NAME } from '../../src/mcp/server.js';
import { RECON_INSTRUCTIONS } from '../../src/mcp/instructions.js';

const RECON_BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/recon-wrxn');

describe('R1b config filename rebrand', () => {
  it('initConfig writes .recon-wrxn.json (not the legacy .recon.json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwx-cfg-'));
    try {
      expect(initConfig(dir)).toBe(true);
      expect(existsSync(join(dir, '.recon-wrxn.json'))).toBe(true);
      expect(existsSync(join(dir, '.recon.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig reads .recon-wrxn.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwx-cfg-'));
    try {
      writeFileSync(join(dir, '.recon-wrxn.json'), JSON.stringify({ port: 4242 }));
      expect(loadConfig(dir).port).toBe(4242);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig ignores a legacy .recon.json (old brand no longer read)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwx-cfg-'));
    try {
      writeFileSync(join(dir, '.recon.json'), JSON.stringify({ port: 9999 }));
      expect(loadConfig(dir).port).toBe(3100); // default, not 9999
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R1b MCP server identity', () => {
  it('server registers under the recon-wrxn name', () => {
    expect(SERVER_NAME).toBe('recon-wrxn');
  });
});

describe('R1c full white-label — MCP instructions carry no Recon brand', () => {
  it('RECON_INSTRUCTIONS reads recon-wrxn, never the capitalized "Recon" brand', () => {
    expect(RECON_INSTRUCTIONS).toMatch(/recon-wrxn/);
    expect(RECON_INSTRUCTIONS).not.toMatch(/\bRecon\b/);
  });
});

describe('R1b index dir rebrand (real binary)', () => {
  it('index writes to .recon-wrxn/ and never creates a .recon/ dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'rwx-idx-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'export function hello(){return 1}\n');
      execFileSync('node', [RECON_BIN, 'index', '--no-embeddings'], {
        cwd: root,
        stdio: 'pipe',
      });
      expect(existsSync(join(root, '.recon-wrxn', 'graph.json'))).toBe(true);
      expect(existsSync(join(root, '.recon'))).toBe(false);
      const g = JSON.parse(readFileSync(join(root, '.recon-wrxn', 'graph.json'), 'utf-8'));
      expect(g.nodes.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

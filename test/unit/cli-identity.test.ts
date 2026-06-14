/**
 * R1a — fork identity: package/binary rename + derivative license notice.
 * Pins the rebrand of the *package identity*. Runtime-surface rebrand
 * (config filename, index dir, MCP namespace, tool names) is R1b.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildProgram } from '../../src/cli/program.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

describe('recon-wrxn package identity', () => {
  it('package is renamed from recon-mcp to recon-wrxn', () => {
    expect(pkg.name).toBe('recon-wrxn');
  });

  it('binary is renamed from recon to recon-wrxn', () => {
    expect(Object.keys(pkg.bin)).toEqual(['recon-wrxn']);
  });
});

describe('recon-wrxn CLI program', () => {
  it('reports the rebranded program name', () => {
    expect(buildProgram().name()).toBe('recon-wrxn');
  });

  it('reports the package version (not a stale hardcoded string)', () => {
    expect(buildProgram().version()).toBe(pkg.version);
  });
});

describe('license + derivative notice (MIT hard constraint)', () => {
  it('LICENSE preserves jhm1909 MIT copyright verbatim', () => {
    const license = readFileSync(
      new URL('../../LICENSE', import.meta.url),
      'utf8',
    );
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2026 jhm1909');
  });

  it('NOTICE declares recon-wrxn a derivative of recon-mcp', () => {
    const notice = readFileSync(
      new URL('../../NOTICE', import.meta.url),
      'utf8',
    );
    expect(notice).toMatch(/recon-wrxn/);
    expect(notice).toMatch(/derivative/i);
    expect(notice).toMatch(/recon-mcp/);
    expect(notice).toMatch(/jhm1909/);
  });
});

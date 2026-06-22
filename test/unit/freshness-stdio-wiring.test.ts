/**
 * Unit Tests: freshness footer over the stdio MCP path ([#9] D1)
 *
 * The primary serve + cold-CLI answer path is the stdio MCP server. createServer accepts
 * the graph's indexed commit; each CallTool computes the watermark at answer time from
 * git against projectRoot and the footer rides the markdown the agent reads. Exercised
 * end to end through a real in-memory MCP client against a REAL temp git repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/mcp/server.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recon-stdio-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
function node(id: string, name: string): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/main.ts', startLine: 1, endLine: 5,
    language: Language.TypeScript, package: 'src', exported: true,
  };
}
function graphWith(name: string): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(node('f1', name));
  return g;
}
async function connect(server: ReturnType<typeof createServer>): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}
function textOf(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content)[0].text;
}

describe('[#9] freshness footer over stdio MCP', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  const clients: Client[] = [];
  let dir: string;

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await Promise.all(servers.map((s) => s.close().catch(() => {})));
    servers.length = 0; clients.length = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('find over stdio carries the footer with the live dirty count', async () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
    const indexed = git(dir, 'rev-parse', '--short', 'HEAD');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n'); // dirty after index

    const server = createServer(graphWith('getUserById'), dir, null, indexed);
    servers.push(server);
    const client = await connect(server);
    clients.push(client);

    const res = await client.callTool({ name: 'recon_find', arguments: { query: 'getUserById' } });
    const text = textOf(res);
    expect(text).toContain('getUserById');
    expect(text).toContain(`indexed @ ${indexed}, 1 files dirty`);
  });

  it('impact over stdio (absence + dirty) carries the footer AND the warning', async () => {
    dir = initRepo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
    const indexed = git(dir, 'rev-parse', '--short', 'HEAD');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n'); // dirty (untracked)

    // single node → upstream impact has no callers → absence answer
    const server = createServer(graphWith('Lonely'), dir, null, indexed);
    servers.push(server);
    const client = await connect(server);
    clients.push(client);

    const res = await client.callTool({
      name: 'recon_impact', arguments: { target: 'Lonely', direction: 'upstream' },
    });
    const text = textOf(res);
    expect(text).toContain(`indexed @ ${indexed}, 1 files dirty`);
    expect(text.toLowerCase()).toContain('verify before acting on this absence');
  });

  it('without an indexed commit the stdio answer stays footer-free (back-compat)', async () => {
    const server = createServer(graphWith('getUserById'), undefined, null);
    servers.push(server);
    const client = await connect(server);
    clients.push(client);

    const res = await client.callTool({ name: 'recon_find', arguments: { query: 'getUserById' } });
    expect(textOf(res)).not.toContain('indexed @');
  });
});

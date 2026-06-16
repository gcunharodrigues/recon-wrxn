/**
 * Unit Tests: createServer vectorStore getter (P1.5 slice C, PART 3)
 *
 * serve brings hybrid search online mid-session by hot-swapping the live
 * vectorStore when a detached background embed lands embeddings.json. The MCP
 * handler must therefore resolve the store PER CallTool request, not capture it
 * once at startup. createServer/startServer accept either a value (back-compat,
 * tests + HTTP path) or a getter resolved on each call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { KnowledgeGraph } from '../../src/graph/graph.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';
import { VectorStore } from '../../src/search/vector-store.js';

function makeNode(id: string, name: string): Node {
  return {
    id, type: NodeType.Function, name,
    file: 'src/main.ts', startLine: 1, endLine: 5,
    language: Language.TypeScript, package: 'src', exported: true,
  };
}

function graphWith(name: string): KnowledgeGraph {
  const g = new KnowledgeGraph();
  g.addNode(makeNode('f1', name));
  return g;
}

async function connect(server: ReturnType<typeof createServer>) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('createServer vectorStore getter', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await Promise.all(servers.map((s) => s.close().catch(() => {})));
    servers.length = 0;
    clients.length = 0;
  });

  it('resolves the getter on every CallTool request and sees a mid-session swap', async () => {
    const storeA = new VectorStore(3);
    const storeB = new VectorStore(3);
    storeB.add('f1', new Float32Array([1, 0, 0]), NodeType.Function);

    let live: VectorStore | null = storeA;
    const getter = vi.fn(() => live);

    const server = createServer(graphWith('getUserById'), undefined, getter);
    servers.push(server);
    const client = await connect(server);
    clients.push(client);

    await client.callTool({ name: 'recon_find', arguments: { query: 'getUserById' } });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(getter.mock.results[0].value).toBe(storeA);

    // Mid-session swap: the next request must resolve to the NEW store.
    live = storeB;
    await client.callTool({ name: 'recon_find', arguments: { query: 'getUserById' } });
    expect(getter).toHaveBeenCalledTimes(2);
    expect(getter.mock.results[1].value).toBe(storeB);
  });

  it('still accepts a plain VectorStore value (back-compat caller)', async () => {
    const store = new VectorStore(3);
    store.add('f1', new Float32Array([1, 0, 0]), NodeType.Function);

    const server = createServer(graphWith('getUserById'), undefined, store);
    servers.push(server);
    const client = await connect(server);
    clients.push(client);

    const res = await client.callTool({ name: 'recon_find', arguments: { query: 'getUserById' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('getUserById');
  });

  it('still accepts null (no embeddings) — BM25-only path', async () => {
    const server = createServer(graphWith('getUserById'), undefined, null);
    servers.push(server);
    const client = await connect(server);
    clients.push(client);

    const res = await client.callTool({ name: 'recon_find', arguments: { query: 'getUserById' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('getUserById');
  });
});

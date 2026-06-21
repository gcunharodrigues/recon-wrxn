/**
 * MCP Server
 *
 * Creates and configures the recon-wrxn MCP server with stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeGraph } from '../graph/graph.js';
import type { VectorStore } from '../search/vector-store.js';
import { RECON_TOOLS } from './tools.js';
import { handleToolCall } from './handlers.js';
import { computeFreshness } from './freshness.js';
import type { FreshnessProvider } from './freshness.js';

import { RECON_INSTRUCTIONS } from './instructions.js';
import {
  getResourceDefinitions,
  getResourceTemplates,
  readResource,
} from './resources.js';
import { RECON_PROMPTS, getPromptMessages } from './prompts.js';

const VERSION = '1.0.0';

/** White-labeled MCP server identity (the namespace surfaced to agents). */
export const SERVER_NAME = 'recon-wrxn';

/**
 * The vector store the MCP handlers use. Either a fixed value (the back-compat
 * caller — tests, the HTTP path) OR a getter resolved on EACH CallTool request.
 * The getter form lets `serve` hot-swap the live store mid-session when a detached
 * background embed lands embeddings.json, bringing hybrid search online with no
 * restart (P1.5 slice C).
 */
export type VectorStoreSource =
  | VectorStore
  | null
  | undefined
  | (() => VectorStore | null | undefined);

/**
 * Create a configured MCP Server with all handlers registered.
 */
export function createServer(
  graph: KnowledgeGraph,
  projectRoot?: string,
  vectorStore?: VectorStoreSource,
  indexedCommit?: string,
  // [#11] D2: when serve runs a live watcher, it injects this provider so the footer reads
  // the live dirty set (near-zero steady state). Absent → the cold-path git compute below.
  freshnessProvider?: FreshnessProvider,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: RECON_INSTRUCTIONS,
    },
  );

  // ─── ListResources ────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: getResourceDefinitions().map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  // ─── ListResourceTemplates ───────────────────────────────────

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: getResourceTemplates().map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      description: t.description,
      mimeType: t.mimeType,
    })),
  }));

  // ─── ReadResource ────────────────────────────────────────────

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
      const content = readResource(uri, graph);
      return {
        contents: [{ uri, mimeType: 'text/yaml', text: content }],
      };
    } catch (err) {
      return {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  });

  // ─── ListTools ──────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: RECON_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // ─── CallTool ───────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Resolve the store PER request so a mid-session live-swap is seen by the
      // very next CallTool — handleToolCall's signature is unchanged.
      const vs = typeof vectorStore === 'function' ? vectorStore() : vectorStore;
      // The freshness watermark for this answer. In serve with a live watcher ([#11] D2) the
      // injected provider returns the live dirty-set count (no git per answer). Otherwise
      // ([#9] cold path: `serve --no-watch`, tests) it is computed at ANSWER TIME from git
      // against projectRoot with the indexed commit as the base. Skipped when projectRoot/
      // commit are absent → no footer (back-compat). Either way it never re-indexes.
      const freshness = freshnessProvider
        ? freshnessProvider()
        : projectRoot && indexedCommit
          ? computeFreshness({ projectRoot, indexedCommit })
          : undefined;
      const result = await handleToolCall(
        name,
        args as Record<string, unknown> | undefined,
        graph,
        projectRoot,
        vs,
        freshness,
      );
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // ─── ListPrompts ─────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: RECON_PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  // ─── GetPrompt ──────────────────────────────────────────────

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const messages = getPromptMessages(name, args as Record<string, string>);
    return { messages };
  });

  return server;
}

/**
 * Start the MCP server on stdio transport.
 */
export async function startServer(
  graph: KnowledgeGraph,
  projectRoot?: string,
  vectorStore?: VectorStoreSource,
  indexedCommit?: string,
  freshnessProvider?: FreshnessProvider,
): Promise<void> {
  const server = createServer(graph, projectRoot, vectorStore, indexedCommit, freshnessProvider);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch {
      // Ignore close errors
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  process.stdout.on('error', shutdown);

  await server.connect(transport);
}

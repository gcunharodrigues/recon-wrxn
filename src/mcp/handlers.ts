/**
 * MCP Tool Handlers (v6)
 *
 * Dispatches 9 tool calls to their respective modules:
 *   recon_map, recon_find, recon_explain, recon_impact,
 *   recon_changes, recon_rename, recon_export, recon_rules, recon_drift
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { KnowledgeGraph } from '../graph/graph.js';
import { NodeType, RelationshipType, Language } from '../graph/types.js';
import type { Node, Relationship } from '../graph/types.js';
import { VectorStore } from '../search/vector-store.js';
import { executeFind, executeFindHybrid, formatFindResults, toFindHits } from './find.js';
import type { FindOptions, FindResult, FindHit } from './find.js';
import { isEmbedderReady, embedText } from '../search/embedder.js';
import { runRule, formatRuleResult, isProseType } from './rules.js';
import type { RuleName } from './rules.js';
import { symbolNotFound, ambiguousSymbol, invalidParameter, emptyGraph } from './errors.js';
import { planRename, formatRenameResult } from './rename.js';
import { exportGraph } from '../export/exporter.js';
import type { ExportOptions } from '../export/exporter.js';
import { analyzeChanges, formatReview } from '../review/reviewer.js';
import { detectProcesses } from '../graph/process.js';
import { computeDrift, formatDrift } from './drift.js';
import type { DriftReport } from './drift.js';
import { appendFreshness } from './freshness.js';
import type { Freshness } from './freshness.js';

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Resolve a symbol name to a single node, with optional file disambiguator.
 * Returns { node } on success, or { error } on failure.
 */
function resolveSymbol(
  graph: KnowledgeGraph,
  name: string,
  fileFilter?: string,
): { node: Node; error?: undefined } | { node?: undefined; error: string } {
  let matches = graph.findByName(name);

  if (fileFilter) {
    matches = matches.filter(n => n.file.includes(fileFilter));
  }

  if (matches.length === 0) {
    // Collect similar names for suggestion
    const similar = findSimilarNames(graph, name);
    return { error: symbolNotFound(name, similar).toJSON() };
  }

  // Disambiguate: prefer exact case match
  if (matches.length > 1) {
    const exact = matches.filter(n => n.name === name);
    if (exact.length > 0) matches = exact;
  }
  // Disambiguate: prefer exported symbols
  if (matches.length > 1) {
    const exported = matches.filter(n => n.exported);
    if (exported.length > 0) matches = exported;
  }

  if (matches.length > 1) {
    return { error: ambiguousSymbol(
      name,
      matches.map(m => ({ name: m.name, file: m.file })),
    ).toJSON() };
  }

  return { node: matches[0] };
}

/**
 * Find similar symbol names for "did you mean?" suggestions.
 */
function findSimilarNames(graph: KnowledgeGraph, name: string): string[] {
  const lower = name.toLowerCase();
  const similar: string[] = [];
  const seen = new Set<string>();

  for (const node of graph.nodes.values()) {
    if (node.type === NodeType.Package || node.type === NodeType.File) continue;
    const nodeLower = node.name.toLowerCase();
    if (seen.has(nodeLower)) continue;

    if (nodeLower.includes(lower) || lower.includes(nodeLower)) {
      seen.add(nodeLower);
      similar.push(node.name);
      if (similar.length >= 5) break;
    }
  }

  return similar;
}

function refFromRel(
  graph: KnowledgeGraph,
  rel: Relationship,
  side: 'source' | 'target',
): { name: string; file: string; line: number; edgeType: string } {
  const id = side === 'source' ? rel.sourceId : rel.targetId;
  const node = graph.getNode(id);
  return {
    name: node?.name || id,
    file: node?.file || '',
    line: node?.startLine || 0,
    edgeType: rel.type,
  };
}

function isTestFile(file: string): boolean {
  return /[._]test\.|[._]spec\.|__tests__|test\/|tests\/|_test\.go$/i.test(file);
}

function findProjectRoot(): string {
  try {
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function detectTechStack(projectRoot: string): string[] {
  const stack: string[] = [];

  // Node.js / JavaScript
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const detect: [string, string][] = [
        ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'],
        ['@angular/core', 'Angular'], ['express', 'Express'],
        ['@nestjs/core', 'NestJS'], ['fastify', 'Fastify'],
        ['vite', 'Vite'], ['vitest', 'Vitest'], ['jest', 'Jest'],
        ['tailwindcss', 'Tailwind'], ['prisma', 'Prisma'],
      ];
      for (const [pkg, name] of detect) {
        if (deps[pkg]) stack.push(name);
      }
    } catch {}
  }

  // Go
  const goMod = join(projectRoot, 'go.mod');
  if (existsSync(goMod)) {
    try {
      const content = readFileSync(goMod, 'utf-8');
      const goDetect: [string, string][] = [
        ['gin-gonic/gin', 'Gin'], ['labstack/echo', 'Echo'],
        ['gofiber/fiber', 'Fiber'], ['go-chi/chi', 'Chi'],
      ];
      for (const [pkg, name] of goDetect) {
        if (content.includes(pkg)) stack.push(name);
      }
    } catch {}
  }

  // Python
  for (const pyFile of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const p = join(projectRoot, pyFile);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8');
        const pyDetect: [string, string][] = [
          ['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'],
          ['pytest', 'pytest'],
        ];
        for (const [pkg, name] of pyDetect) {
          if (content.toLowerCase().includes(pkg)) stack.push(name);
        }
      } catch {}
      break;
    }
  }

  // Rust
  const cargo = join(projectRoot, 'Cargo.toml');
  if (existsSync(cargo)) {
    try {
      const content = readFileSync(cargo, 'utf-8');
      const rustDetect: [string, string][] = [
        ['actix', 'Actix'], ['axum', 'Axum'], ['rocket', 'Rocket'], ['tokio', 'Tokio'],
      ];
      for (const [pkg, name] of rustDetect) {
        if (content.includes(pkg)) stack.push(name);
      }
    } catch {}
  }

  // Infrastructure
  if (existsSync(join(projectRoot, 'Dockerfile')) || existsSync(join(projectRoot, 'docker-compose.yml'))) {
    stack.push('Docker');
  }
  if (existsSync(join(projectRoot, '.github', 'workflows'))) {
    stack.push('GitHub Actions');
  }

  return [...new Set(stack)]; // deduplicate
}

// ─── Main Dispatcher ──────────────────────────────────────────

/**
 * Handle a tool call and return formatted text result.
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  graph: KnowledgeGraph,
  projectRoot?: string,
  vectorStore?: VectorStore | null,
  freshness?: Freshness,
): Promise<string> {
  const a = args ?? {};
  // Check for empty graph (except recon_map which should show empty state)
  if (name !== 'recon_map' && graph.nodeCount === 0) {
    return emptyGraph().toJSON();
  }

  switch (name) {
    case 'recon_map':
      return handleMap(a, graph, projectRoot);

    case 'recon_find':
      return await handleFind(a, graph, vectorStore, freshness);

    case 'recon_explain':
      return handleExplain(a, graph, freshness);

    case 'recon_impact':
      return handleImpact(a, graph, freshness);

    case 'recon_changes':
      return handleChanges(a, graph, projectRoot);

    case 'recon_rename':
      return handleRename(a, graph);

    case 'recon_export':
      return handleExport(a, graph);

    case 'recon_rules':
      return handleRules(a, graph);

    case 'recon_drift':
      return handleDrift(graph);

    default:
      return JSON.stringify({ error: 'unknown_tool', tool: name });
  }
}

// ─── recon_map ────────────────────────────────────────────────

function handleMap(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
  projectRoot?: string,
): string {
  const langFilter = (args?.language as string) || 'all';

  // Collect package nodes
  const packages: Node[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== NodeType.Package) continue;

    if (langFilter === 'go' && node.language !== Language.Go) continue;
    if (langFilter === 'typescript' && node.language !== Language.TypeScript && node.language !== Language.Tsx) continue;

    packages.push(node);
  }

  packages.sort((a, b) => a.package.localeCompare(b.package));

  // Count nodes by language
  const langCounts = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    if (node.type === NodeType.Package || node.type === NodeType.File) continue;
    if (isProseType(node.type)) continue; // prose excluded from language counts
    const lang = node.language || 'unknown';
    langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
  }

  // Build importedBy for each package
  const importedByMap = new Map<string, string[]>();
  for (const node of packages) {
    const incoming = graph.getIncoming(node.id, RelationshipType.IMPORTS);
    const importers = incoming.map((r) => {
      const src = graph.getNode(r.sourceId);
      return src?.package || r.sourceId;
    });
    importedByMap.set(node.id, importers);
  }

  const totalRels = graph.relationshipCount;

  // Detect tech stack
  const root = projectRoot || findProjectRoot();
  const techStack = detectTechStack(root);

  // Format output
  const lines: string[] = [
    '# recon-wrxn -- Package Overview',
    '',
    `**Stats:** ${packages.length} packages, ${graph.nodeCount} nodes, ${totalRels} relationships`,
  ];

  if (techStack.length > 0) {
    lines.push(`**Stack:** ${techStack.join(', ')}`);
  }

  // Language breakdown
  if (langCounts.size > 0) {
    const langSummary = Array.from(langCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(', ');
    lines.push(`**Languages:** ${langSummary}`);
  }

  lines.push('');

  for (const pkg of packages) {
    const fileCount = pkg.files?.length || 0;
    const imports = pkg.imports || [];
    const importedBy = importedByMap.get(pkg.id) || [];

    lines.push(`## ${pkg.package}`);
    if (pkg.importPath) lines.push(`Import: \`${pkg.importPath}\``);
    lines.push(`Language: ${pkg.language} | Files: ${fileCount}`);

    if (imports.length > 0) {
      lines.push(`Imports: ${imports.join(', ')}`);
    }
    if (importedBy.length > 0) {
      lines.push(`Imported by: ${importedBy.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── recon_find ───────────────────────────────────────────────

/**
 * Core find: query → filtered FindResult[] (hybrid score fields populated on the
 * hybrid fulltext path). Shared by the markdown handler (stdio, handleFind) and the
 * structured HTTP door (findStructured). The caller guarantees args.query is present.
 */
async function findResults(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
  vectorStore?: VectorStore | null,
): Promise<FindResult[]> {
  const query = args.query as string;

  const options: FindOptions = {};
  if (args?.type) options.type = args.type as NodeType;
  if (args?.limit) options.limit = args.limit as number;

  // Hybrid retrieval (BM25 ⊕ vector via RRF) on the fulltext path when embeddings
  // are loaded AND the query embedder is ready; otherwise executeFindHybrid falls
  // back to pure BM25. Embeddings stay off the optional-dependency hot path: we
  // only pass embedText once the singleton is initialized.
  const embedQuery = vectorStore && isEmbedderReady() ? embedText : null;

  // Apply language and package filters via post-filtering
  let results = await executeFindHybrid(graph, query, options, vectorStore, embedQuery);

  // Fallback: if exact search found nothing, retry with wildcard pattern
  if (results.length === 0 && !query.includes('*') && !query.includes('?')) {
    results = executeFind(graph, `*${query}*`, options);
  }

  // Apply additional filters not handled by executeFind
  let filtered = results;
  if (args?.language) {
    const langFilter = (args.language as string).toLowerCase();
    filtered = filtered.filter(r => {
      const node = graph.getNode(r.id);
      return node && node.language.toLowerCase() === langFilter;
    });
  }
  if (args?.package) {
    const pkgFilter = args.package as string;
    filtered = filtered.filter(r => r.package.includes(pkgFilter));
  }

  return filtered;
}

async function handleFind(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
  vectorStore?: VectorStore | null,
  freshness?: Freshness,
): Promise<string> {
  const query = args?.query as string;
  if (!query) {
    return invalidParameter('query', '', ['<search term>']).toJSON();
  }
  const filtered = await findResults(args, graph, vectorStore);
  const result = formatFindResults(filtered);
  // Absence answer for find = no results; the footer (+ scoped warning when dirty)
  // is appended only when a freshness watermark is injected (the injected-input seam).
  if (!freshness) return result;
  return appendFreshness(result, freshness, { absence: filtered.length === 0 });
}

/**
 * Structured find for the HTTP door (recon-brain-recall-01). Returns BOTH the
 * agent-facing markdown — byte-identical to the stdio recon_find output — and the
 * structured per-hit array that node-stdlib consumers (the Recall hook, slice 04)
 * read for the cosine + arm provenance. Mirrors handleToolCall's empty-graph +
 * missing-query guards so the markdown matches the stdio path exactly; on either
 * guard `hits` is the empty array.
 */
export async function findStructured(
  args: Record<string, unknown> | undefined,
  graph: KnowledgeGraph,
  vectorStore?: VectorStore | null,
): Promise<{ result: string; hits: FindHit[] }> {
  const a = args ?? {};
  if (graph.nodeCount === 0) {
    return { result: emptyGraph().toJSON(), hits: [] };
  }
  const query = a?.query as string;
  if (!query) {
    return { result: invalidParameter('query', '', ['<search term>']).toJSON(), hits: [] };
  }
  const filtered = await findResults(a, graph, vectorStore);
  return { result: formatFindResults(filtered), hits: toFindHits(filtered) };
}

// ─── recon_explain ────────────────────────────────────────────

function handleExplain(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
  freshness?: Freshness,
): string {
  const name = args?.name as string;
  const fileFilter = args?.file as string;

  if (!name) {
    return invalidParameter('name', '', ['<symbol name>']).toJSON();
  }

  const resolved = resolveSymbol(graph, name, fileFilter);
  if (resolved.error) return resolved.error;
  const node = resolved.node!;

  const incoming = graph.getIncoming(node.id);
  const outgoing = graph.getOutgoing(node.id);

  const callers = incoming
    .filter(r => r.type === RelationshipType.CALLS || r.type === RelationshipType.CALLS_API)
    .map(r => refFromRel(graph, r, 'source'));

  const callees = outgoing
    .filter(r => r.type === RelationshipType.CALLS || r.type === RelationshipType.CALLS_API)
    .map(r => refFromRel(graph, r, 'target'));

  const importedBy = incoming
    .filter(r => r.type === RelationshipType.IMPORTS)
    .map(r => refFromRel(graph, r, 'source'));

  const imports = outgoing
    .filter(r => r.type === RelationshipType.IMPORTS)
    .map(r => refFromRel(graph, r, 'target'));

  const methods = outgoing
    .filter(r => r.type === RelationshipType.HAS_METHOD)
    .map(r => refFromRel(graph, r, 'target'));

  const implementedBy = incoming
    .filter(r => r.type === RelationshipType.IMPLEMENTS)
    .map(r => refFromRel(graph, r, 'source'));

  const usedBy = incoming
    .filter(r => r.type === RelationshipType.USES_COMPONENT)
    .map(r => refFromRel(graph, r, 'source'));

  // Test references: find test nodes that call this symbol
  const testRefs = incoming
    .filter(r => {
      const src = graph.getNode(r.sourceId);
      return src && src.isTest;
    })
    .map(r => refFromRel(graph, r, 'source'));

  // Format
  const lines: string[] = [
    `# Context: ${node.name}`,
    '',
    `**Type:** ${node.type}`,
    `**File:** \`${node.file}:${node.startLine}-${node.endLine}\``,
    `**Language:** ${node.language}`,
    `**Package:** ${node.package}`,
    `**Exported:** ${node.exported}`,
    ...(node.community ? [`**Community:** ${node.community}`] : []),
    // Prose provenance watermark (sync-01): shown only on a page that declares
    // a `synced_to:` so the field stays absent on the code-symbol majority.
    ...(node.syncedTo ? [`**Synced To:** ${node.syncedTo}`] : []),
    '',
  ];

  const sections: [string, ReturnType<typeof refFromRel>[]][] = [
    ['Callers', callers],
    ['Callees', callees],
    ['Imported By', importedBy],
    ['Imports', imports],
    ['Methods', methods],
    ['Implemented By', implementedBy],
    ['Used By (Components)', usedBy],
  ];

  for (const [title, refs] of sections) {
    lines.push(`### ${title} (${refs.length})`);
    if (refs.length === 0) {
      lines.push('_none_');
    } else {
      for (const ref of refs) {
        lines.push(`- ${ref.name} -- \`${ref.file}:${ref.line}\` [${ref.edgeType}]`);
      }
    }
    lines.push('');
  }

  // Prose ↔ code documentation (recon-prose-analyzer-06). DOCUMENTED_BY is
  // directed Prose → Code, so a Page reads its OUTGOING edges (the code it
  // documents) and a code symbol reads its INCOMING edges (the documenting
  // pages). Shown only when present, to avoid noise on the code-symbol majority.
  const documents = outgoing
    .filter(r => r.type === RelationshipType.DOCUMENTED_BY)
    .map(r => refFromRel(graph, r, 'target'));
  if (documents.length > 0) {
    lines.push(`### Documents (${documents.length})`);
    for (const ref of documents) {
      lines.push(`- ${ref.name} -- \`${ref.file}:${ref.line}\` [${ref.edgeType}]`);
    }
    lines.push('');
  }

  const documentedBy = incoming
    .filter(r => r.type === RelationshipType.DOCUMENTED_BY)
    .map(r => refFromRel(graph, r, 'source'));
  if (documentedBy.length > 0) {
    lines.push(`### Documented By (${documentedBy.length})`);
    for (const ref of documentedBy) {
      lines.push(`- ${ref.name} -- \`${ref.file}:${ref.line}\` [${ref.edgeType}]`);
    }
    lines.push('');
  }

  // Test references
  if (testRefs.length > 0) {
    lines.push(`### Test References (${testRefs.length})`);
    for (const ref of testRefs) {
      lines.push(`- ${ref.name} -- \`${ref.file}:${ref.line}\` [${ref.edgeType}]`);
    }
    lines.push('');
  }

  // Process participation -- show which execution flows this symbol is in
  try {
    const allProcesses = detectProcesses(graph, { limit: 50 });
    const participating: Array<{ processName: string; stepIndex: number; totalSteps: number }> = [];
    for (const proc of allProcesses) {
      if (proc.entryPoint.name === node.name && proc.entryPoint.file === node.file) {
        participating.push({ processName: proc.name, stepIndex: 0, totalSteps: proc.steps.length });
        continue;
      }
      for (let i = 0; i < proc.steps.length; i++) {
        if (proc.steps[i].name === node.name && proc.steps[i].file === node.file) {
          participating.push({ processName: proc.name, stepIndex: i + 1, totalSteps: proc.steps.length });
          break;
        }
      }
    }

    lines.push(`### Execution Flows (${participating.length})`);
    if (participating.length === 0) {
      lines.push('_none_');
    } else {
      for (const p of participating) {
        const role = p.stepIndex === 0 ? 'entry point' : `step ${p.stepIndex}/${p.totalSteps}`;
        lines.push(`- **${p.processName}** (${role})`);
      }
    }
    lines.push('');
  } catch {
    // Skip flow detection on error
  }

  const out = lines.join('\n');
  // recon_explain is a PRESENCE answer (a resolved-symbol context lookup): footer
  // only, never an absence warning. Appended only when a watermark is injected.
  if (!freshness) return out;
  return appendFreshness(out, freshness, { absence: false });
}

/** A structured recon_explain neighbor — what `wrxn brain query --neighbors` renders. */
export type NeighborRelationship =
  | 'caller' | 'callee' | 'import' | 'importedBy'
  | 'method' | 'implementedBy' | 'usedBy' | 'testRef';

export interface NeighborHit {
  name: string;
  type: NodeType;
  file: string;
  line: number;
  relationship: NeighborRelationship;
}

function neighborsFromRels(
  graph: KnowledgeGraph,
  rels: Relationship[],
  side: 'source' | 'target',
  relationship: NeighborRelationship,
): NeighborHit[] {
  return rels.map((r) => {
    const id = side === 'source' ? r.sourceId : r.targetId;
    const n = graph.getNode(id);
    return {
      name: n?.name ?? id,
      type: n?.type ?? NodeType.Function,
      file: n?.file ?? '',
      line: n?.startLine ?? 0,
      relationship,
    };
  });
}

/**
 * Structured projection of recon_explain's neighborhood — the SAME 8 relationship
 * categories handleExplain renders in markdown, flattened to NeighborHit[]. Mirrors
 * toFindHits: a SEPARATE projection of the same graph traversal, so the markdown the
 * stdio path emits stays untouched (recon-brain-recall-review #5).
 */
function collectNeighbors(graph: KnowledgeGraph, node: Node): NeighborHit[] {
  const incoming = graph.getIncoming(node.id);
  const outgoing = graph.getOutgoing(node.id);
  const isCall = (t: RelationshipType) =>
    t === RelationshipType.CALLS || t === RelationshipType.CALLS_API;
  return [
    ...neighborsFromRels(graph, incoming.filter(r => isCall(r.type)), 'source', 'caller'),
    ...neighborsFromRels(graph, outgoing.filter(r => isCall(r.type)), 'target', 'callee'),
    ...neighborsFromRels(graph, outgoing.filter(r => r.type === RelationshipType.IMPORTS), 'target', 'import'),
    ...neighborsFromRels(graph, incoming.filter(r => r.type === RelationshipType.IMPORTS), 'source', 'importedBy'),
    ...neighborsFromRels(graph, outgoing.filter(r => r.type === RelationshipType.HAS_METHOD), 'target', 'method'),
    ...neighborsFromRels(graph, incoming.filter(r => r.type === RelationshipType.IMPLEMENTS), 'source', 'implementedBy'),
    ...neighborsFromRels(graph, incoming.filter(r => r.type === RelationshipType.USES_COMPONENT), 'source', 'usedBy'),
    ...neighborsFromRels(graph, incoming.filter((r) => {
      const src = graph.getNode(r.sourceId);
      return Boolean(src && src.isTest);
    }), 'source', 'testRef'),
  ];
}

/**
 * Structured recon_explain for the HTTP door (recon-brain-recall-review #5). Returns
 * the agent-facing markdown — byte-identical to the stdio recon_explain output — AND
 * the structured `neighbors` the kernel CLI's `--neighbors` view reads. Mirrors
 * handleToolCall's empty-graph guard + handleExplain's missing/unresolved guards so
 * the markdown matches the stdio path exactly; on any guard `neighbors` is empty.
 */
export function explainStructured(
  args: Record<string, unknown> | undefined,
  graph: KnowledgeGraph,
): { result: string; neighbors: NeighborHit[] } {
  const a = args ?? {};
  if (graph.nodeCount === 0) {
    return { result: emptyGraph().toJSON(), neighbors: [] };
  }
  const result = handleExplain(a, graph);
  const name = a?.name as string;
  if (!name) return { result, neighbors: [] };
  const resolved = resolveSymbol(graph, name, a?.file as string);
  if (resolved.error) return { result, neighbors: [] };
  return { result, neighbors: collectNeighbors(graph, resolved.node!) };
}

// ─── recon_impact ─────────────────────────────────────────────

function handleImpact(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
  freshness?: Freshness,
): string {
  const target = args?.target as string;
  const direction = (args?.direction as string) || 'upstream';
  const fileFilter = args?.file as string;

  if (!target) {
    return invalidParameter('target', '', ['<symbol name>']).toJSON();
  }

  if (!['upstream', 'downstream'].includes(direction)) {
    return invalidParameter('direction', direction, ['upstream', 'downstream']).toJSON();
  }

  const maxDepth = (args?.maxDepth as number) || 3;

  const resolved = resolveSymbol(graph, target, fileFilter);
  if (resolved.error) return resolved.error;
  const targetNode = resolved.node!;

  // BFS traversal
  const visited = new Set<string>([targetNode.id]);
  let frontier = [targetNode.id];
  const byDepth: Array<{
    depth: number;
    label: string;
    symbols: Array<{
      name: string;
      type: string;
      file: string;
      line: number;
      edgeType: string;
      confidence: number;
      isTest: boolean;
    }>;
  }> = [];

  const depthLabels = [
    '',
    'WILL BREAK -- direct callers/importers',
    'LIKELY AFFECTED -- indirect dependents',
    'MAY NEED TESTING -- transitive',
  ];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    const symbols: typeof byDepth[0]['symbols'] = [];

    for (const nodeId of frontier) {
      const edges = direction === 'upstream'
        ? graph.getIncoming(nodeId)
        : graph.getOutgoing(nodeId);

      for (const edge of edges) {
        // Documentation edges (Page -DOCUMENTED_BY-> code) are not code dependencies:
        // editing a doc does not break the code it documents. The node-gate below stops
        // prose neighbors, but a DOCUMENTED_BY edge from a Page TARGET reaches a CODE
        // neighbor that would pass that gate — so skip the edge type itself, keeping the
        // blast radius code-only in both directions (qa-finding-02).
        if (edge.type === RelationshipType.DOCUMENTED_BY) continue;
        const neighborId = direction === 'upstream' ? edge.sourceId : edge.targetId;
        if (visited.has(neighborId)) continue;

        const neighbor = graph.getNode(neighborId);
        if (!neighbor) continue;
        if (isProseType(neighbor.type)) continue; // prose never enters the blast radius

        visited.add(neighborId);
        nextFrontier.push(neighborId);
        symbols.push({
          name: neighbor.name,
          type: neighbor.type,
          file: neighbor.file,
          line: neighbor.startLine,
          edgeType: edge.type,
          confidence: edge.confidence,
          isTest: neighbor.isTest || isTestFile(neighbor.file),
        });
      }
    }

    if (symbols.length > 0) {
      byDepth.push({
        depth,
        label: depthLabels[depth] || `Depth ${depth}`,
        symbols,
      });
    }

    frontier = nextFrontier;
  }

  // Separate test nodes from non-test nodes
  const allSymbols = byDepth.flatMap(d => d.symbols);
  const testNodes = allSymbols.filter(s => s.isTest);
  const nonTestSymbols = allSymbols.filter(s => !s.isTest);

  // Risk calculation based on d=1 non-test count
  const d1NonTest = (byDepth.find(d => d.depth === 1)?.symbols || []).filter(s => !s.isTest);
  const d1Count = d1NonTest.length;

  const crossApp = new Set(nonTestSymbols
    .map(s => s.file.match(/^apps\/([^/]+)/)?.[1])
    .filter(Boolean),
  ).size > 1;

  let risk: string;
  if (d1Count >= 20 || crossApp) risk = 'CRITICAL';
  else if (d1Count >= 10) risk = 'HIGH';
  else if (d1Count >= 3) risk = 'MEDIUM';
  else risk = 'LOW';

  const totalAffected = nonTestSymbols.length;

  // Format
  const lines: string[] = [
    `# Impact Analysis: ${targetNode.name}`,
    '',
    `**Target:** ${targetNode.name} (${targetNode.type}) -- \`${targetNode.file}:${targetNode.startLine}\``,
    `**Direction:** ${direction}`,
    `**Risk:** ${risk}`,
    `**Summary:** ${d1Count} direct ${direction === 'upstream' ? 'callers' : 'callees'}, ${totalAffected} total affected`,
    '',
  ];

  for (const group of byDepth) {
    const groupNonTest = group.symbols.filter(s => !s.isTest);
    if (groupNonTest.length === 0) continue;

    lines.push(`## d=${group.depth}: ${group.label} (${groupNonTest.length})`);
    lines.push('');

    for (const sym of groupNonTest) {
      lines.push(`- **${sym.name}** (${sym.type}) -- \`${sym.file}:${sym.line}\` [${sym.edgeType}]`);
    }
    lines.push('');
  }

  // Affected tests section
  if (testNodes.length > 0) {
    lines.push(`## Affected Tests (${testNodes.length})`);
    lines.push('');
    for (const t of testNodes) {
      lines.push(`- **${t.name}** -- \`${t.file}:${t.line}\``);
    }
    lines.push('');
  }

  const out = lines.join('\n');
  // Absence answer for impact = an empty blast radius (no non-test callers/dependents).
  // The footer (+ scoped warning when dirty) is appended only when a watermark is
  // injected (the injected-input seam).
  if (!freshness) return out;
  return appendFreshness(out, freshness, { absence: totalAffected === 0 });
}

// ─── recon_changes ────────────────────────────────────────────

function handleChanges(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
  projectRoot?: string,
): string {
  const root = projectRoot || findProjectRoot();

  const options = {
    scope: (args?.scope as 'staged' | 'unstaged' | 'branch' | 'all') || 'unstaged',
    base: (args?.base as string) || 'main',
    includeDiagram: (args?.include_diagram as boolean) ?? false,
  };

  const result = analyzeChanges(graph, root, options);
  return formatReview(result, graph, options);
}

// ─── recon_rename ─────────────────────────────────────────────

function handleRename(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
): string {
  const symbolName = args?.symbol as string;
  const newName = args?.new_name as string;
  const fileFilter = args?.file as string | undefined;
  const dryRun = (args?.dry_run as boolean) ?? true;

  if (!symbolName) {
    return invalidParameter('symbol', '', ['<current symbol name>']).toJSON();
  }
  if (!newName) {
    return invalidParameter('new_name', '', ['<new name>']).toJSON();
  }

  const result = planRename(graph, symbolName, newName, fileFilter, dryRun);

  // If planRename returned a disambiguation string, convert to structured error
  if (typeof result === 'string') {
    // planRename returns a string when ambiguous -- wrap in structured error
    const matches = graph.findByName(symbolName);
    return ambiguousSymbol(
      symbolName,
      matches.map(m => ({ name: m.name, file: m.file })),
    ).toJSON();
  }

  return formatRenameResult(result);
}

// ─── recon_export ─────────────────────────────────────────────

function handleExport(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
): string {
  const options: ExportOptions = {
    format: 'mermaid',
    symbol: args?.target as string | undefined,
    depth: (args?.depth as number) || 2,
    limit: (args?.limit as number) || 30,
    skipFiles: true,
    direction: (args?.direction as 'TD' | 'LR') || 'TD',
  };

  // Map scope to appropriate option
  const scope = args?.scope as string | undefined;
  if (scope === 'package' && args?.target) {
    options.package = args.target as string;
    options.symbol = undefined; // use package filter, not ego graph
  }

  const output = exportGraph(graph, options);

  const nodeCount = output.split('\n').filter((l: string) => l.includes('[') || l.includes('label=')).length;
  return `# Export (mermaid)\n\n\`\`\`mermaid\n${output}\n\`\`\`\n\n_${nodeCount} nodes rendered._`;
}

// ─── recon_rules ──────────────────────────────────────────────

function handleRules(
  args: Record<string, unknown>,
  graph: KnowledgeGraph,
): string {
  const VALID_RULES: RuleName[] = ['dead_code', 'unused_exports', 'circular_deps', 'large_files', 'orphans'];

  const ruleArg = args?.rule as string | undefined;

  if (ruleArg && !VALID_RULES.includes(ruleArg as RuleName)) {
    return invalidParameter('rule', ruleArg, VALID_RULES).toJSON();
  }

  // If a specific rule is requested, run only that one
  if (ruleArg) {
    const result = runRule(graph, ruleArg as RuleName);
    return formatRuleResult(result);
  }

  // Run all rules and combine output
  const lines: string[] = ['# Code Quality Report', ''];

  let totalIssues = 0;
  for (const rule of VALID_RULES) {
    const result = runRule(graph, rule);
    totalIssues += result.count;
    lines.push(formatRuleResult(result));
    lines.push('');
  }

  lines.unshift(''); // add blank after header
  lines.splice(1, 0, `**Total issues:** ${totalIssues}`);

  return lines.join('\n');
}

// ─── recon_drift ──────────────────────────────────────────────

/**
 * The computable stale set (sync-03): a pure indexed-graph compare of each
 * watermarked derived page against its source symbol's current fingerprint.
 * No args — it reports drift across the whole indexed corpus.
 */
function handleDrift(graph: KnowledgeGraph): string {
  return formatDrift(computeDrift(graph));
}

/**
 * Structured recon_drift for the HTTP door (sync-08). Returns the agent-facing
 * markdown — byte-identical to the stdio recon_drift output — AND the full
 * structured `DriftReport` the kernel sync loop (sync-04) reads for the
 * machine-readable stale set. Mirrors findStructured/explainStructured: a SEPARATE
 * projection of the SAME computeDrift call, so the markdown the stdio path emits
 * stays untouched. recon_drift takes no args (it reports across the whole indexed
 * corpus); `args` is accepted only for door-call parity with its siblings.
 * Mirrors handleToolCall's empty-graph guard so the markdown matches stdio exactly;
 * on that guard the report is the empty (all-buckets-empty) shape.
 */
export function driftStructured(
  args: Record<string, unknown> | undefined,
  graph: KnowledgeGraph,
): { result: string; drift: DriftReport } {
  void args;
  if (graph.nodeCount === 0) {
    return {
      result: emptyGraph().toJSON(),
      drift: { stale: [], unwatermarked: [], multiAnchor: [], uncomparable: [], orphaned: [], fresh: 0 },
    };
  }
  const report = computeDrift(graph);
  return { result: formatDrift(report), drift: report };
}

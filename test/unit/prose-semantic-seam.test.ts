/**
 * Vector-store seam test (recon-prose-analyzer-03, AC4) — REAL embedding model.
 *
 * Proves the semantic payoff at the vector-store/embedder seam (recon exposes no
 * semantic route through recon_find yet — that lands in slice -04). The flow:
 *
 *   embedText("<conceptual query>") → node_type-scoped VectorStore.search([Page,Section])
 *     → returns a conceptually-related prose node that shares NO surface keyword
 *       with the query, while code vectors are excluded by the scope.
 *
 * Uses the real Xenova/all-MiniLM-L6-v2 model (auto-downloads on first run, then
 * cached). If the model can't be loaded (truly offline, no cache) the test logs a
 * skip and passes — mirrors the repo's existing defensive embedder tests so the
 * suite stays green everywhere, while exercising the real model wherever it's present.
 *
 * Embedding source: the production embedder.embedText() is preferred. Its optional-
 * dependency loader (`Function('return import("@huggingface/transformers")')`) is
 * deliberately opaque to bundlers and ALSO to vitest's module runner, which can't
 * resolve the bare specifier through it — so under vitest we fall back to loading
 * the exact same model directly (identical pooling/normalize). Either way the real
 * model embeds real prose. (The production embedText path is verified end-to-end by
 * a real `recon index` run / `node` invocation, where the Function-import resolves.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initEmbedder, embedText, disposeEmbedder } from '../../src/search/embedder.js';
import { VectorStore } from '../../src/search/vector-store.js';
import { generateEmbeddingText } from '../../src/search/text-generator.js';
import { NodeType, Language } from '../../src/graph/types.js';
import type { Node } from '../../src/graph/types.js';

const MODEL_TIMEOUT = 300_000; // model download + embed can take minutes on a cold first run

function proseNode(id: string, name: string, type: NodeType): Node {
  return {
    id, type, name, file: 'docs/x.md', startLine: 1, endLine: 1,
    language: Language.Markdown, package: 'docs', exported: false,
  };
}
function codeNode(id: string, name: string): Node {
  return {
    id, type: NodeType.Function, name, file: 'src/util.ts', startLine: 1, endLine: 5,
    language: Language.TypeScript, package: 'util', exported: true,
  };
}

// Content words (drop stopwords + very short tokens) for the "no surface keyword" check.
const STOP = new Set(['the', 'a', 'an', 'at', 'it', 'its', 'so', 'to', 'of', 'and', 'on', 'in',
  'for', 'is', 'are', 'as', 'with', 'that', 'this', 'they', 'them', 'each', 'every']);
function contentWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2 && !STOP.has(w)));
}

describe('vector-store seam: node-type-scoped semantic prose search (real model)', () => {
  let ready = false;
  let usedProductionEmbedder = false;
  let embed: (text: string) => Promise<Float32Array>;

  beforeAll(async () => {
    // Prefer the production embedder.embedText().
    try {
      await initEmbedder();
      embed = embedText;
      usedProductionEmbedder = true;
      ready = true;
      return;
    } catch {
      /* vitest can't resolve the Function-wrapped optional import — load directly below */
    }
    // Fall back: load the SAME model directly (vitest resolves a plain dynamic import).
    try {
      const transformers: any = await import('@huggingface/transformers');
      const pipe = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
      embed = async (text: string) => {
        const out = await pipe(text, { pooling: 'mean', normalize: true });
        return new Float32Array(out.data);
      };
      ready = true;
    } catch (err) {
      console.warn(`[prose-semantic-seam] model unavailable, skipping real-model test: ${(err as Error).message}`);
    }
  }, MODEL_TIMEOUT);

  afterAll(async () => {
    if (usedProductionEmbedder) await disposeEmbedder();
  });

  it('a conceptual query lands the related prose node with NO shared surface keywords; code is scoped out', async () => {
    if (!ready) return; // model unavailable — skip (logged in beforeAll)

    // Target prose: gardening / watering plants.
    const target = proseNode('md:page:garden.md', 'Watering the garden', NodeType.Page);
    const targetBody = 'The gardener sprinkles water over the plants every morning so the flowers bloom.';
    // Distractor prose: finance — semantically far from the query.
    const distractor = proseNode('md:page:finance.md', 'Quarterly earnings report', NodeType.Page);
    const distractorBody = 'Financial markets fluctuate with investor sentiment and reported revenue each quarter.';
    // Code node: must be excluded by prose-scoping.
    const code = codeNode('ts:func:src/util.ts:computeChecksum', 'computeChecksum');

    const store = new VectorStore(384);
    store.add(target.id, await embed(generateEmbeddingText(target, targetBody)), target.type);
    store.add(distractor.id, await embed(generateEmbeddingText(distractor, distractorBody)), distractor.type);
    store.add(code.id, await embed(generateEmbeddingText(code)), code.type);

    // Conceptually identical to the gardening node, but disjoint vocabulary.
    const query = 'irrigating vegetation at dawn makes blossoms open';
    const queryEmb = await embed(query);

    // Pre-condition the AC demands: the query shares NO surface keyword with the
    // target node's embedded text — the match must be purely semantic.
    const q = contentWords(query);
    const t = contentWords(`${target.name} ${targetBody}`);
    const shared = [...q].filter(w => t.has(w));
    expect(shared).toEqual([]);

    // node_type-scoped search: prose only.
    const prose = store.search(queryEmb, 10, { nodeType: [NodeType.Page, NodeType.Section] });
    const proseIds = prose.map(r => r.nodeId);

    // The conceptually-related prose node ranks first...
    expect(prose[0].nodeId).toBe(target.id);
    // ...above the finance distractor...
    expect(proseIds.indexOf(target.id)).toBeLessThan(proseIds.indexOf(distractor.id));
    // ...and the code node never appears in a prose-scoped result (no cross-modality dilution).
    expect(proseIds).not.toContain(code.id);

    // Sanity: the same store, queried for code only, returns the code node and no prose.
    const codeOnly = store.search(queryEmb, 10, { nodeType: NodeType.Function }).map(r => r.nodeId);
    expect(codeOnly).toEqual([code.id]);
  }, MODEL_TIMEOUT);
});

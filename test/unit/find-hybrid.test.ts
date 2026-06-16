/**
 * Unit Tests: hybrid RRF retrieval + interrogative-query classifier fix
 * (recon-prose-analyzer-04)
 *
 * Two behaviors are locked here:
 *  (B) classifyQuery demotes an interrogative-led question with a weak structural
 *      signal (<2 keywords) to fulltext, so a conceptual question that happens to
 *      contain a structural keyword ("…orphan analysis…") still reaches retrieval
 *      instead of being diverted to the structural strategy.
 *  (A) executeFindHybrid fuses BM25 ⊕ node-type-scoped vector results via RRF on
 *      the fulltext path, with a built-in fallback to pure BM25 when the embedding
 *      layer is absent/empty/throwing. Asserted with an INJECTED fake embedder —
 *      transformers.js does not run under vitest, so the embedder is a parameter.
 */
import { describe, it, expect } from 'vitest';
import { classifyQuery } from '../../src/mcp/find.js';
import type { QueryStrategy } from '../../src/mcp/find.js';

// ─── (B) Classifier: interrogative-question demotion ─────────────

describe('classifyQuery — interrogative-question demotion (recon-prose-analyzer-04)', () => {
  it('demotes the gold Q2 "why … orphan analysis …" question to fulltext', () => {
    // Contains the structural keyword "orphan" but is a conceptual question with
    // <2 structural keywords → must reach fulltext, not divert to structural.
    expect(classifyQuery('why is static import and orphan analysis unreliable here'))
      .toBe<QueryStrategy>('fulltext');
  });

  it('demotes "how does the test harness work" to fulltext (contains "test", 1 kw)', () => {
    expect(classifyQuery('how does the test harness work')).toBe<QueryStrategy>('fulltext');
  });

  it('demotes "why is the orphan check unreliable" to fulltext (contains "orphan", 1 kw)', () => {
    expect(classifyQuery('why is the orphan check unreliable')).toBe<QueryStrategy>('fulltext');
  });

  it('KEEPS a 2-keyword question structural ("what are the exported functions with no callers")', () => {
    // The <2 guard preserves a strong structural signal even when phrased as a question.
    expect(classifyQuery('what are the exported functions with no callers'))
      .toBe<QueryStrategy>('structural');
  });

  it('leaves a non-question structural query unchanged ("orphan dead code")', () => {
    expect(classifyQuery('orphan dead code')).toBe<QueryStrategy>('structural');
  });
});

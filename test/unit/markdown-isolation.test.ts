/**
 * Unit Tests: Markdown analyzer per-file parse isolation.
 *
 * One pathological .md (e.g. a deeply-nested construct that throws
 * `RangeError: Maximum call stack size exceeded` inside the mdast parser) must
 * NOT abort the whole index pass. analyzeMarkdown should skip the bad file,
 * record a warning, and keep the healthy files — mirroring the tree-sitter
 * analyzer's warnings[] behavior.
 *
 * The parser is mocked to throw for a sentinel input, delegating every other
 * file to the real parser — so the test doesn't depend on a parser-version-
 * specific crash input.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mdast-util-from-markdown')>();
  return {
    ...actual,
    fromMarkdown: (value: unknown, ...rest: unknown[]) => {
      const text = typeof value === 'string' ? value : String(value);
      if (text.includes('__BOOM__')) {
        throw new RangeError('Maximum call stack size exceeded');
      }
      return (actual.fromMarkdown as (...a: unknown[]) => unknown)(value, ...rest);
    },
  };
});

import { analyzeMarkdown } from '../../src/analyzers/markdown.js';
import type { MarkdownFile } from '../../src/analyzers/markdown.js';
import { NodeType } from '../../src/graph/types.js';

describe('analyzeMarkdown — per-file parse isolation', () => {
  it('skips a file that throws and still returns the other files + a warning', () => {
    const files: MarkdownFile[] = [
      { path: 'good-before.md', content: '# Before\nbody before.\n' },
      { path: 'bad.md', content: '# Bad\n__BOOM__ pathological input\n' },
      { path: 'good-after.md', content: '# After\nbody after.\n' },
    ];

    const result = analyzeMarkdown(files);

    // Both healthy files still produce their Page nodes — the throw did not
    // abort the loop before good-after.md was reached.
    const pageIds = result.nodes
      .filter((n) => n.type === NodeType.Page)
      .map((n) => n.id)
      .sort();
    expect(pageIds).toEqual(['md:page:good-after.md', 'md:page:good-before.md']);

    // The bad file contributes NOTHING to the graph (atomic skip).
    expect(result.nodes.some((n) => n.file === 'bad.md')).toBe(false);

    // ...but it is surfaced as a warning, the way the tree-sitter path does.
    expect(result.warnings.map((w) => w.file)).toContain('bad.md');
    expect(result.warnings.find((w) => w.file === 'bad.md')!.reason).toMatch(/call stack/i);
  });
});

/**
 * Unit Tests: Position-free symbol ids (BL-070 R1)
 *
 * Symbol ids must NOT encode startLine, so an edit ABOVE a symbol does not
 * re-key it (which would drop cross-file edges — incremental-lossy). Collisions
 * within a single file are disambiguated by a stable source-order ordinal `~N`.
 */
import { describe, it, expect } from 'vitest';
import { Language, NodeType } from '../../src/graph/types.js';
import { extractFromFile } from '../../src/analyzers/tree-sitter/index.js';

describe('position-free symbol ids', () => {
  // Two classes, each with a `constructor` method → same base id within ONE file.
  const COLLIDING_CODE = `
class Alpha {
  constructor() {
    this.a = 1;
  }
}

class Beta {
  constructor() {
    this.b = 2;
  }
}

function uniqueHelper() {
  return 42;
}
`;

  it('(a) disambiguates same-named methods in one file with ~0 / ~1', () => {
    const result = extractFromFile('shapes.cjs', COLLIDING_CODE, Language.JavaScript);
    const ctors = result.symbols
      .filter(s => s.type === NodeType.Method && s.name === 'constructor')
      .sort((x, y) => x.startLine - y.startLine);

    expect(ctors.length).toBe(2);
    const base = 'js:method:shapes.cjs:constructor';
    expect(ctors[0].id).toBe(`${base}~0`);
    expect(ctors[1].id).toBe(`${base}~1`);
    // Distinct ids
    expect(ctors[0].id).not.toBe(ctors[1].id);
    // Ordinal follows source order (Alpha before Beta)
    expect(ctors[0].startLine).toBeLessThan(ctors[1].startLine);
  });

  it('(b) non-colliding symbol id has no trailing line number and no ~ suffix', () => {
    const result = extractFromFile('shapes.cjs', COLLIDING_CODE, Language.JavaScript);
    const helper = result.symbols.find(s => s.name === 'uniqueHelper');

    expect(helper).toBeDefined();
    expect(helper!.id).toBe('js:func:shapes.cjs:uniqueHelper');
    // No `~` ordinal suffix for a single-member group
    expect(helper!.id).not.toContain('~');
    // No trailing `:<line>` — the last segment is the bare name
    expect(helper!.id.endsWith(':uniqueHelper')).toBe(true);
    expect(helper!.id).not.toMatch(/:\d+$/);
  });

  it('(c) id is stable when lines shift (position-free property)', () => {
    const before = extractFromFile('shapes.cjs', COLLIDING_CODE, Language.JavaScript);
    const helperBefore = before.symbols.find(s => s.name === 'uniqueHelper')!;
    const lineBefore = helperBefore.startLine;

    // Prepend a blank line → every startLine shifts +1.
    const shifted = '\n' + COLLIDING_CODE;
    const after = extractFromFile('shapes.cjs', shifted, Language.JavaScript);
    const helperAfter = after.symbols.find(s => s.name === 'uniqueHelper')!;

    // startLine actually moved …
    expect(helperAfter.startLine).toBe(lineBefore + 1);
    // … but the id is UNCHANGED.
    expect(helperAfter.id).toBe(helperBefore.id);

    // And the colliding ordinals remain stable too.
    const ctorsBefore = before.symbols.filter(s => s.name === 'constructor').map(s => s.id).sort();
    const ctorsAfter = after.symbols.filter(s => s.name === 'constructor').map(s => s.id).sort();
    expect(ctorsAfter).toEqual(ctorsBefore);
  });
});

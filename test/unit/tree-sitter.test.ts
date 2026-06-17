/**
 * Unit Tests: Tree-sitter Multi-Language Support
 *
 * Tests the tree-sitter analyzer: parser loading, query-based extraction,
 * graph construction, and language-specific features.
 */
import { describe, it, expect } from 'vitest';
import { NodeType, RelationshipType, Language } from '../../src/graph/types.js';
import {
  getLanguageForFile,
  isLanguageAvailable,
  getAvailableLanguages,
  extractFromFile,
  buildGraphFromExtractions,
  LANGUAGE_QUERIES,
} from '../../src/analyzers/tree-sitter/index.js';
import { KnowledgeGraph } from '../../src/graph/index.js';
import { findCircularDeps } from '../../src/mcp/rules.js';
import type { FileExtractionResult, ExtractedSymbol } from '../../src/analyzers/tree-sitter/index.js';

// ─── Language Detection ─────────────────────────────────────────

describe('getLanguageForFile', () => {
  it('detects Python files', () => {
    expect(getLanguageForFile('main.py')).toBe(Language.Python);
    expect(getLanguageForFile('script.pyw')).toBe(Language.Python);
  });

  it('detects Rust files', () => {
    expect(getLanguageForFile('lib.rs')).toBe(Language.Rust);
  });

  it('detects Java files', () => {
    expect(getLanguageForFile('Main.java')).toBe(Language.Java);
  });

  it('detects C files', () => {
    expect(getLanguageForFile('main.c')).toBe(Language.C);
    expect(getLanguageForFile('header.h')).toBe(Language.C);
  });

  it('detects C++ files', () => {
    expect(getLanguageForFile('main.cpp')).toBe(Language.Cpp);
    expect(getLanguageForFile('class.cc')).toBe(Language.Cpp);
    expect(getLanguageForFile('header.hpp')).toBe(Language.Cpp);
    expect(getLanguageForFile('other.cxx')).toBe(Language.Cpp);
    expect(getLanguageForFile('h.hxx')).toBe(Language.Cpp);
    expect(getLanguageForFile('x.hh')).toBe(Language.Cpp);
  });

  it('detects TypeScript/TSX files', () => {
    expect(getLanguageForFile('file.ts')).toBe(Language.TypeScript);
    expect(getLanguageForFile('file.mts')).toBe(Language.TypeScript);
    expect(getLanguageForFile('file.cts')).toBe(Language.TypeScript);
    expect(getLanguageForFile('component.tsx')).toBe(Language.Tsx);
  });

  it('returns undefined for unsupported extensions', () => {
    expect(getLanguageForFile('file.txt')).toBeUndefined();
    expect(getLanguageForFile('Makefile')).toBeUndefined();
  });
});

// ─── Query Definitions ──────────────────────────────────────────

describe('LANGUAGE_QUERIES', () => {
  it('has queries for all tree-sitter languages', () => {
    expect(LANGUAGE_QUERIES[Language.Python]).toBeDefined();
    expect(LANGUAGE_QUERIES[Language.Rust]).toBeDefined();
    expect(LANGUAGE_QUERIES[Language.Java]).toBeDefined();
    expect(LANGUAGE_QUERIES[Language.C]).toBeDefined();
    expect(LANGUAGE_QUERIES[Language.Cpp]).toBeDefined();
  });

  it('does not have queries for Go (handled by a dedicated analyzer)', () => {
    expect(LANGUAGE_QUERIES[Language.Go]).toBeUndefined();
  });

  it('has queries for TypeScript and TSX (now tree-sitter, not the compiler-API path)', () => {
    expect(LANGUAGE_QUERIES[Language.TypeScript]).toBeDefined();
    expect(LANGUAGE_QUERIES[Language.Tsx]).toBeDefined();
    expect(LANGUAGE_QUERIES[Language.TypeScript]).toContain('@definition.function');
    expect(LANGUAGE_QUERIES[Language.TypeScript]).toContain('@definition.interface');
    expect(LANGUAGE_QUERIES[Language.TypeScript]).toContain('@import.source');
  });

  it('queries contain definition patterns', () => {
    for (const lang of [Language.Python, Language.Rust, Language.C, Language.Cpp]) {
      const q = LANGUAGE_QUERIES[lang]!;
      expect(q).toContain('@definition.function');
      expect(q).toContain('@name');
    }
    // Java has methods instead of standalone functions
    expect(LANGUAGE_QUERIES[Language.Java]).toContain('@definition.method');
    expect(LANGUAGE_QUERIES[Language.Java]).toContain('@definition.class');
  });

  it('queries contain call patterns', () => {
    for (const lang of [Language.Python, Language.Rust, Language.Java, Language.C, Language.Cpp]) {
      const q = LANGUAGE_QUERIES[lang]!;
      expect(q).toContain('@call.name');
    }
  });

  it('queries contain import patterns', () => {
    for (const lang of [Language.Python, Language.Rust, Language.Java, Language.C, Language.Cpp]) {
      const q = LANGUAGE_QUERIES[lang]!;
      expect(q).toContain('@import');
    }
  });
});

// ─── Parser Availability ────────────────────────────────────────

describe('parser availability', () => {
  it('has at least one language available', () => {
    const langs = getAvailableLanguages();
    expect(langs.length).toBeGreaterThan(0);
  });

  it('reports Python as available', () => {
    expect(isLanguageAvailable(Language.Python)).toBe(true);
  });

  it('reports Rust as available', () => {
    expect(isLanguageAvailable(Language.Rust)).toBe(true);
  });

  it('reports Java as available', () => {
    expect(isLanguageAvailable(Language.Java)).toBe(true);
  });

  it('reports C as available', () => {
    expect(isLanguageAvailable(Language.C)).toBe(true);
  });

  it('reports C++ as available', () => {
    expect(isLanguageAvailable(Language.Cpp)).toBe(true);
  });

  it('reports Go as available', () => {
    expect(isLanguageAvailable(Language.Go)).toBe(true);
  });
});

// ─── Python Extraction ──────────────────────────────────────────

describe('extractFromFile: Python', () => {
  const PYTHON_CODE = `
import os
from pathlib import Path

class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof"

def create_dog(name):
    return Dog(name)

def _private_helper():
    pass
`;

  it('extracts class definitions', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    const classes = result.symbols.filter(s => s.type === NodeType.Class);
    expect(classes.length).toBe(2);
    expect(classes.map(c => c.name)).toContain('Animal');
    expect(classes.map(c => c.name)).toContain('Dog');
  });

  it('extracts function definitions', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    const funcs = result.symbols.filter(s => s.type === NodeType.Function);
    const names = funcs.map(f => f.name);
    expect(names).toContain('create_dog');
    expect(names).toContain('_private_helper');
    // Methods inside classes are also captured as functions in Python
    expect(names).toContain('__init__');
    expect(names).toContain('speak');
  });

  it('detects Python export conventions', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    const priv = result.symbols.find(s => s.name === '_private_helper');
    expect(priv?.exported).toBe(false);

    const pub = result.symbols.find(s => s.name === 'create_dog');
    expect(pub?.exported).toBe(true);
  });

  it('extracts imports', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    const sources = result.imports.map(i => i.source);
    expect(sources).toContain('os');
    expect(sources).toContain('pathlib');
  });

  it('extracts calls', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    const callNames = result.calls.map(c => c.calleeName);
    expect(callNames).toContain('Dog');
  });

  it('extracts class inheritance', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    expect(result.heritage.length).toBe(1);
    expect(result.heritage[0].childName).toBe('Dog');
    expect(result.heritage[0].parentName).toBe('Animal');
    expect(result.heritage[0].kind).toBe('extends');
  });

  it('sets correct file and language', () => {
    const result = extractFromFile('src/models/animals.py', PYTHON_CODE, Language.Python);
    for (const sym of result.symbols) {
      expect(sym.file).toBe('src/models/animals.py');
      expect(sym.language).toBe(Language.Python);
      expect(sym.package).toBe('src/models');
    }
  });

  it('generates unique IDs with py: prefix', () => {
    const result = extractFromFile('animals.py', PYTHON_CODE, Language.Python);
    const ids = result.symbols.map(s => s.id);
    for (const id of ids) {
      expect(id).toMatch(/^py:/);
    }
    // All unique
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── JavaScript Extraction (Slice B1: symbols + CALLS only) ─────

describe('extractFromFile: JavaScript', () => {
  const JS_CODE = `
function add(a, b) {
  return a + b;
}

const double = (x) => x * 2;

const named = function () {
  return add(1, 2);
};

function* gen() {
  yield 1;
}

class Counter extends Base {
  increment() {
    this.n++;
  }
}

function run() {
  add();
}
`;

  // AC-5b — ABI guard. MUST be the first assertion in this block:
  // a wrong-ABI grammar load is swallowed silently by loadLanguages()'s
  // try/catch, producing 0 symbols indistinguishable from "not registered".
  // This assertion turns that silent failure into a RED test.
  it('reports JavaScript as available (ABI guard)', () => {
    expect(isLanguageAvailable(Language.JavaScript)).toBe(true);
  });

  // AC-5a — extension dispatch
  it('detects JavaScript files by extension', () => {
    expect(getLanguageForFile('x.cjs')).toBe(Language.JavaScript);
    expect(getLanguageForFile('x.js')).toBe(Language.JavaScript);
    expect(getLanguageForFile('x.mjs')).toBe(Language.JavaScript);
    expect(getLanguageForFile('x.jsx')).toBe(Language.JavaScript);
  });

  // AC-5c — symbol extraction from a .cjs fixture
  it('extracts function, arrow, generator, class and method symbols', () => {
    const result = extractFromFile('fixture.cjs', JS_CODE, Language.JavaScript);

    const funcs = result.symbols.filter(s => s.type === NodeType.Function);
    const names = funcs.map(f => f.name);
    expect(names).toContain('add');     // function_declaration
    expect(names).toContain('double');  // variable_declarator -> arrow_function
    expect(names).toContain('named');   // variable_declarator -> function_expression
    expect(names).toContain('gen');     // generator_function_declaration

    const classes = result.symbols.filter(s => s.type === NodeType.Class);
    expect(classes.map(c => c.name)).toContain('Counter');

    const methods = result.symbols.filter(s => s.type === NodeType.Method);
    expect(methods.map(m => m.name)).toContain('increment');
  });

  it('generates symbol IDs with js: prefix', () => {
    const result = extractFromFile('fixture.cjs', JS_CODE, Language.JavaScript);
    expect(result.symbols.length).toBeGreaterThan(0);
    for (const sym of result.symbols) {
      expect(sym.id).toMatch(/^js:/);
    }
  });

  it('extracts class inheritance (EXTENDS)', () => {
    const result = extractFromFile('fixture.cjs', JS_CODE, Language.JavaScript);
    const ext = result.heritage.find(h => h.childName === 'Counter');
    expect(ext).toBeDefined();
    expect(ext?.parentName).toBe('Base');
    expect(ext?.kind).toBe('extends');
  });

  // AC-5d — CALLS edge between two JS functions
  it('creates a CALLS edge from run to add', () => {
    const map = new Map<string, FileExtractionResult>();
    map.set('fixture.cjs', extractFromFile('fixture.cjs', `
function add() {
  return 1;
}

function run() {
  add();
}
`, Language.JavaScript));

    const result = buildGraphFromExtractions(map);
    const calls = result.relationships.filter(r => r.type === RelationshipType.CALLS);
    const runToAdd = calls.find(c => {
      const source = result.nodes.find(n => n.id === c.sourceId);
      const target = result.nodes.find(n => n.id === c.targetId);
      return source?.name === 'run' && target?.name === 'add';
    });
    expect(runToAdd).toBeDefined();
  });

  // AC-5e — B2 boundary guard: a single-file JS fixture yields ZERO IMPORTS
  // edges. require() is B2 scope; in B1 it flows through as a plain CALLS
  // edge at most. If an IMPORTS pass is ever added, this fails RED.
  it('yields ZERO IMPORTS edges (B1/B2 boundary guard)', () => {
    const map = new Map<string, FileExtractionResult>();
    map.set('fixture.cjs', extractFromFile('fixture.cjs', `
const dep = require('./other');

function use() {
  return dep.run();
}
`, Language.JavaScript));

    const result = buildGraphFromExtractions(map);
    const imports = result.relationships.filter(r => r.type === RelationshipType.IMPORTS);
    expect(imports).toHaveLength(0);
  });

  // Story 5.6 — large-file (>32KB) parse fix. node-tree-sitter@0.21's
  // parser.parse(string) throws "Invalid argument" when the source exceeds
  // ~32767 bytes (e.g. tools/os-metrics.cjs at 51KB was silently skipped by
  // `recon index`). The fix passes a large bufferSize as the third parse arg.
  // RED pre-fix: extractFromFile throws / yields 0 symbols on a >32KB source.
  it('parses a >32KB JS source without error and extracts symbols (Story 5.6)', () => {
    // Build a synthetic JS source string > 32767 bytes with DISTINCT function
    // names so the extracted symbols are real, not deduped to one.
    let big = '';
    let i = 0;
    while (Buffer.byteLength(big, 'utf8') <= 33000) {
      big += `function bigFn${i}() { return ${i}; }\n`;
      i++;
    }
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(32767);

    // Pre-fix this throws "Invalid argument"; post-fix it must not throw.
    const result = extractFromFile('big.cjs', big, Language.JavaScript);

    const funcs = result.symbols.filter(s => s.type === NodeType.Function);
    expect(funcs.length).toBeGreaterThanOrEqual(1);
    // Distinct names prove real extraction across the whole >32KB span.
    const names = funcs.map(f => f.name);
    expect(names).toContain('bigFn0');
    expect(names).toContain(`bigFn${i - 1}`);
  });
});

// ─── JavaScript require() → IMPORTS edges + File nodes (Slice B2) ─

describe('buildGraphFromExtractions: JavaScript IMPORTS', () => {
  // Helper: build a multi-file extraction Map keyed by project-relative path.
  // The keys mirror analyzer.ts's `relativePath` contract (project-relative,
  // forward-slash). This is the format buildGraphFromExtractions resolves against.
  function jsMap(entries: Record<string, string>): Map<string, FileExtractionResult> {
    const map = new Map<string, FileExtractionResult>();
    for (const [path, src] of Object.entries(entries)) {
      map.set(path, extractFromFile(path, src, Language.JavaScript));
    }
    return map;
  }

  function importsOf(result: ReturnType<typeof buildGraphFromExtractions>) {
    return result.relationships.filter(r => r.type === RelationshipType.IMPORTS);
  }
  function fileNodesOf(result: ReturnType<typeof buildGraphFromExtractions>) {
    return result.nodes.filter(n => n.type === NodeType.File);
  }

  // AC-6g — NON-JS REGRESSION GUARD (the make-or-break, byte-identical).
  // A single-file Python fixture, run before vs after the IMPORTS pass, must
  // produce a byte-identical graph: ZERO File nodes, ZERO IMPORTS edges, and an
  // unperturbed symbol/CALLS/heritage set. This is the focused proof that the
  // JS-only language gate holds; if it fails RED the gate is missing/wrong.
  it('AC-6g: non-JS (Python) fixture yields ZERO File nodes + ZERO IMPORTS edges (byte-identical)', () => {
    const PY = `
import os
from pathlib import Path

class Animal:
    def speak(self):
        return make()

def make():
    return Animal()
`;
    const map = new Map<string, FileExtractionResult>();
    map.set('models/animals.py', extractFromFile('models/animals.py', PY, Language.Python));
    const result = buildGraphFromExtractions(map);

    // No File nodes for a non-JS language.
    expect(fileNodesOf(result)).toHaveLength(0);
    // No IMPORTS edges for a non-JS language (the import[] array exists but must
    // never be turned into IMPORTS edges by the JS-only-gated pass).
    expect(importsOf(result)).toHaveLength(0);

    // Byte-identical full-graph snapshot (order-normalized deep equality):
    // capture the exact node + relationship sets so a stray File node OR a
    // perturbed symbol/CALLS/heritage edge is caught, not just a count drift.
    const norm = (g: ReturnType<typeof buildGraphFromExtractions>) => ({
      nodes: [...g.nodes].map(n => ({ ...n })).sort((a, b) => a.id.localeCompare(b.id)),
      relationships: [...g.relationships].map(r => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(norm(result)).toMatchSnapshot();
  });

  // AC-6d — bare specifier (non-relative) → no edge (skipped before ladder).
  it('AC-6d: bare specifiers (fs, lodash) produce ZERO IMPORTS edges', () => {
    const result = buildGraphFromExtractions(jsMap({
      'a.cjs': `const fs = require('fs'); const _ = require('lodash'); function f(){ return fs; }`,
    }));
    expect(importsOf(result)).toHaveLength(0);
  });

  // AC-6e — dynamic require (variable / template) → not captured → no edge.
  it('AC-6e: dynamic require(variable) and require(template) produce ZERO IMPORTS edges', () => {
    const result = buildGraphFromExtractions(jsMap({
      'a.cjs': 'const m = "lock"; const x = require(m); const y = require(`./${m}`);',
      'lock.cjs': 'function acquire(){}',
    }));
    expect(importsOf(result)).toHaveLength(0);
  });

  // AC-6a — relative require resolves to a File→File IMPORTS edge.
  it('AC-6a: relative require resolves to a File→File IMPORTS edge a -> b', () => {
    const result = buildGraphFromExtractions(jsMap({
      'a.cjs': `const b = require('./b'); function main(){ return b.run(); }`,
      'b.cjs': `function run(){ return 1; }`,
    }));
    const imports = importsOf(result);
    expect(imports.length).toBeGreaterThanOrEqual(1);

    const aFile = result.nodes.find(n => n.type === NodeType.File && n.id === 'js:file:a.cjs');
    const bFile = result.nodes.find(n => n.type === NodeType.File && n.id === 'js:file:b.cjs');
    expect(aFile).toBeDefined();
    expect(bFile).toBeDefined();

    const edge = imports.find(r => r.sourceId === 'js:file:a.cjs' && r.targetId === 'js:file:b.cjs');
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe(1.0);
  });

  // AC-6b — CJS ladder: require without extension resolves to the .cjs file.
  it('AC-6b: require("./c") (no extension) resolves to c.cjs via the CJS ladder', () => {
    const result = buildGraphFromExtractions(jsMap({
      'a.cjs': `require('./c');`,
      'c.cjs': `function helper(){}`,
    }));
    const edge = importsOf(result).find(
      r => r.sourceId === 'js:file:a.cjs' && r.targetId === 'js:file:c.cjs',
    );
    expect(edge).toBeDefined();
  });

  // AC-6c — unresolved relative require → no edge, no throw.
  it('AC-6c: unresolved relative require("./missing") yields ZERO edges and does not throw', () => {
    expect(() => {
      const result = buildGraphFromExtractions(jsMap({
        'a.cjs': `require('./missing');`,
      }));
      expect(importsOf(result)).toHaveLength(0);
    }).not.toThrow();
  });

  // AC-6f — mutual require: exactly one File node per file (idempotent), 2 edges.
  it('AC-6f: mutual require yields exactly 2 File nodes (no dups) and 2 IMPORTS edges', () => {
    const result = buildGraphFromExtractions(jsMap({
      'a.cjs': `require('./b'); function fa(){}`,
      'b.cjs': `require('./a'); function fb(){}`,
    }));
    const fileNodes = fileNodesOf(result);
    const fileIds = fileNodes.map(n => n.id).sort();
    expect(fileIds).toEqual(['js:file:a.cjs', 'js:file:b.cjs']);
    // No duplicate File nodes.
    expect(new Set(fileIds).size).toBe(2);

    const imports = importsOf(result);
    expect(imports).toHaveLength(2);
    expect(imports.find(r => r.sourceId === 'js:file:a.cjs' && r.targetId === 'js:file:b.cjs')).toBeDefined();
    expect(imports.find(r => r.sourceId === 'js:file:b.cjs' && r.targetId === 'js:file:a.cjs')).toBeDefined();
  });

  // Idempotence: running the build twice over the same input yields the same
  // node + relationship set (no File-node duplication, deterministic IDs).
  it('AC-6f: buildGraphFromExtractions is idempotent (re-run = identical graph)', () => {
    const make = () => buildGraphFromExtractions(jsMap({
      'a.cjs': `require('./b');`,
      'b.cjs': `function run(){}`,
    }));
    const r1 = make();
    const r2 = make();
    const ids = (g: ReturnType<typeof buildGraphFromExtractions>) =>
      [...g.nodes.map(n => n.id), ...g.relationships.map(r => r.id)].sort();
    expect(ids(r1)).toEqual(ids(r2));
  });

  // Sub-directory relative require: resolves across directories.
  it('resolves a parent-relative require ("../tools/lock") across directories', () => {
    const result = buildGraphFromExtractions(jsMap({
      'hooks/a.cjs': `require('../tools/lock');`,
      'tools/lock.cjs': `function acquire(){}`,
    }));
    const edge = importsOf(result).find(
      r => r.sourceId === 'js:file:hooks/a.cjs' && r.targetId === 'js:file:tools/lock.cjs',
    );
    expect(edge).toBeDefined();
  });
});

// ─── Directory Package nodes + circular_deps (BL-041 + BL-042) ────

describe('buildGraphFromExtractions: directory Package nodes', () => {
  function jsMap(entries: Record<string, string>): Map<string, FileExtractionResult> {
    const map = new Map<string, FileExtractionResult>();
    for (const [path, src] of Object.entries(entries)) {
      map.set(path, extractFromFile(path, src, Language.JavaScript));
    }
    return map;
  }
  const pkgNodes = (r: ReturnType<typeof buildGraphFromExtractions>) =>
    r.nodes.filter(n => n.type === NodeType.Package);
  const rels = (r: ReturnType<typeof buildGraphFromExtractions>, t: RelationshipType) =>
    r.relationships.filter(x => x.type === t);
  // Load an AnalyzerResult (arrays) into a Map-backed KnowledgeGraph for rule queries.
  const toKG = (r: ReturnType<typeof buildGraphFromExtractions>) => {
    const g = new KnowledgeGraph();
    for (const n of r.nodes) g.addNode(n);
    for (const x of r.relationships) g.addRelationship(x);
    return g;
  };

  it('BL-041: emits one Package node per distinct directory + Package→File CONTAINS', () => {
    const result = buildGraphFromExtractions(jsMap({
      'hooks/a.cjs': `function fa(){}`,
      'hooks/b.cjs': `function fb(){}`,
      'tools/c.cjs': `function fc(){}`,
    }));
    const pkgs = pkgNodes(result).map(n => n.package).sort();
    expect(pkgs).toEqual(['hooks', 'tools']); // two dirs, hooks deduped to one node
    const contains = rels(result, RelationshipType.CONTAINS);
    expect(contains.length).toBe(3); // one per file
    expect(contains.find(c => c.sourceId === 'js:pkg:hooks' && c.targetId === 'js:file:hooks/a.cjs')).toBeDefined();
    expect(contains.find(c => c.sourceId === 'js:pkg:tools' && c.targetId === 'js:file:tools/c.cjs')).toBeDefined();
  });

  it('BL-042: a cross-directory import lifts to a Package→Package IMPORTS edge', () => {
    const result = buildGraphFromExtractions(jsMap({
      'hooks/a.cjs': `require('../tools/lock');`,
      'tools/lock.cjs': `function acquire(){}`,
    }));
    const pkgImports = rels(result, RelationshipType.IMPORTS)
      .filter(r => r.sourceId.startsWith('js:pkg:'));
    expect(pkgImports.length).toBe(1);
    expect(pkgImports[0].sourceId).toBe('js:pkg:hooks');
    expect(pkgImports[0].targetId).toBe('js:pkg:tools');
  });

  it('BL-042: an intra-directory import does NOT create a Package self-loop', () => {
    const result = buildGraphFromExtractions(jsMap({
      'tools/a.cjs': `require('./b');`,
      'tools/b.cjs': `function fb(){}`,
    }));
    const pkgImports = rels(result, RelationshipType.IMPORTS)
      .filter(r => r.sourceId.startsWith('js:pkg:'));
    expect(pkgImports.length).toBe(0); // same package → no cross-package edge, no false 1-cycle
    // The File→File IMPORTS edge is still present (Pass 5 unchanged).
    expect(rels(result, RelationshipType.IMPORTS).some(r => r.sourceId === 'js:file:tools/a.cjs')).toBe(true);
  });

  it('BL-042: findCircularDeps detects a two-package import cycle (was always 0 for JS)', () => {
    // hooks ⇄ tools mutual cross-package require → one package-level cycle.
    const result = buildGraphFromExtractions(jsMap({
      'hooks/a.cjs': `require('../tools/b');`,
      'tools/b.cjs': `require('../hooks/a');`,
    }));
    const cycles = findCircularDeps(toKG(result));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const flat = new Set(cycles.flat());
    expect(flat.has('hooks')).toBe(true);
    expect(flat.has('tools')).toBe(true);
  });

  it('BL-042: findCircularDeps detects a three-package cycle (a -> b -> c -> a)', () => {
    const result = buildGraphFromExtractions(jsMap({
      'a/x.cjs': `require('../b/y');`,
      'b/y.cjs': `require('../c/z');`,
      'c/z.cjs': `require('../a/x');`,
    }));
    const cycles = findCircularDeps(toKG(result));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const flat = new Set(cycles.flat());
    for (const p of ['a', 'b', 'c']) expect(flat.has(p)).toBe(true);
  });

  it('BL-041: a C++ namespace Package and a directory Package coexist without a false cycle', () => {
    // Same dir holds a C++ file (namespace → Package symbol) and a .cjs (directory Package). The two
    // use distinct id shapes (cpp:pkg:<file>:<name>:<line> vs js:pkg:<dir>); the namespace package has
    // no IMPORTS edges, so it must never enter findCircularDeps as a cycle.
    const result = buildGraphFromExtractions(new Map([
      ['lib/geo.cpp', extractFromFile('lib/geo.cpp', 'namespace geo {\n  int area() { return 1; }\n}\n', Language.Cpp)],
      ['lib/x.cjs', extractFromFile('lib/x.cjs', 'function fx(){}', Language.JavaScript)],
    ]));
    const ids = result.nodes.filter(n => n.type === NodeType.Package).map(n => n.id);
    expect(ids).toContain('js:pkg:lib'); // directory package from the .cjs
    expect(ids.some(id => id.startsWith('cpp:pkg:'))).toBe(true); // C++ namespace package, distinct id
    expect(findCircularDeps(toKG(result))).toEqual([]); // no IMPORTS among them → no cycle
  });

  it('BL-041 regression: a non-JS (Python) fixture emits ZERO Package nodes from this pass', () => {
    const result = buildGraphFromExtractions(new Map([
      ['src/m.py', extractFromFile('src/m.py', 'import os\ndef f():\n    return 1\n', Language.Python)],
    ]));
    // No js:pkg:* directory packages for a Python file (Pass 6 is JS-gated like Pass 5).
    expect(result.nodes.filter(n => n.id.startsWith('js:pkg:')).length).toBe(0);
  });
});

// ─── Rust Extraction ────────────────────────────────────────────

describe('extractFromFile: Rust', () => {
  const RUST_CODE = `
use std::collections::HashMap;

pub struct Config {
    pub name: String,
    value: i32,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Validate {
    fn validate(&self) -> bool;
}

impl Validate for Config {
    fn validate(&self) -> bool {
        !self.name.is_empty()
    }
}

pub fn create_config(name: &str) -> Config {
    Config { name: name.to_string(), value: 0 }
}
`;

  it('extracts struct definitions', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    const structs = result.symbols.filter(s => s.type === NodeType.Struct);
    expect(structs.map(s => s.name)).toContain('Config');
  });

  it('extracts enum definitions', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    const enums = result.symbols.filter(s => s.type === NodeType.Enum);
    expect(enums.map(s => s.name)).toContain('Status');
  });

  it('extracts trait definitions', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    const traits = result.symbols.filter(s => s.type === NodeType.Trait);
    expect(traits.map(s => s.name)).toContain('Validate');
  });

  it('extracts function definitions', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    const funcs = result.symbols.filter(s => s.type === NodeType.Function);
    expect(funcs.map(s => s.name)).toContain('create_config');
  });

  it('extracts use imports', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts trait implementation heritage', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    const implHeritage = result.heritage.filter(h => h.kind === 'trait');
    expect(implHeritage.length).toBe(1);
    expect(implHeritage[0].childName).toBe('Config');
    expect(implHeritage[0].parentName).toBe('Validate');
  });

  it('generates rs: prefixed IDs', () => {
    const result = extractFromFile('config.rs', RUST_CODE, Language.Rust);
    for (const sym of result.symbols) {
      expect(sym.id).toMatch(/^rs:/);
    }
  });
});

// ─── Java Extraction ────────────────────────────────────────────

describe('extractFromFile: Java', () => {
  const JAVA_CODE = `
import java.util.List;
import java.util.ArrayList;

public class UserService {
    private List<User> users = new ArrayList<>();

    public User findById(int id) {
        return users.get(id);
    }

    public void addUser(User user) {
        users.add(user);
    }
}

interface Repository {
    void save(Object entity);
}

enum Role {
    ADMIN,
    USER,
    GUEST
}
`;

  it('extracts class definitions', () => {
    const result = extractFromFile('UserService.java', JAVA_CODE, Language.Java);
    const classes = result.symbols.filter(s => s.type === NodeType.Class);
    expect(classes.map(s => s.name)).toContain('UserService');
  });

  it('extracts interface definitions', () => {
    const result = extractFromFile('UserService.java', JAVA_CODE, Language.Java);
    const ifaces = result.symbols.filter(s => s.type === NodeType.Interface);
    expect(ifaces.map(s => s.name)).toContain('Repository');
  });

  it('extracts enum definitions', () => {
    const result = extractFromFile('UserService.java', JAVA_CODE, Language.Java);
    const enums = result.symbols.filter(s => s.type === NodeType.Enum);
    expect(enums.map(s => s.name)).toContain('Role');
  });

  it('extracts method definitions', () => {
    const result = extractFromFile('UserService.java', JAVA_CODE, Language.Java);
    const methods = result.symbols.filter(s => s.type === NodeType.Method);
    const names = methods.map(s => s.name);
    expect(names).toContain('findById');
    expect(names).toContain('addUser');
  });

  it('extracts imports', () => {
    const result = extractFromFile('UserService.java', JAVA_CODE, Language.Java);
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it('generates java: prefixed IDs', () => {
    const result = extractFromFile('UserService.java', JAVA_CODE, Language.Java);
    for (const sym of result.symbols) {
      expect(sym.id).toMatch(/^java:/);
    }
  });
});

// ─── C Extraction ───────────────────────────────────────────────

describe('extractFromFile: C', () => {
  const C_CODE = `
#include <stdio.h>
#include "utils.h"

struct Point {
    int x;
    int y;
};

enum Color { RED, GREEN, BLUE };

void print_point(struct Point p) {
    printf("(%d, %d)", p.x, p.y);
}

int add(int a, int b) {
    return a + b;
}

#define MAX_SIZE 100
`;

  it('extracts function definitions', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    const funcs = result.symbols.filter(s => s.type === NodeType.Function);
    const names = funcs.map(s => s.name);
    expect(names).toContain('print_point');
    expect(names).toContain('add');
  });

  it('extracts struct definitions', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    const structs = result.symbols.filter(s => s.type === NodeType.Struct);
    expect(structs.map(s => s.name)).toContain('Point');
  });

  it('extracts enum definitions', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    const enums = result.symbols.filter(s => s.type === NodeType.Enum);
    expect(enums.map(s => s.name)).toContain('Color');
  });

  it('extracts includes as imports', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts macro definitions', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    const macros = result.symbols.filter(s => s.name === 'MAX_SIZE');
    expect(macros.length).toBe(1);
  });

  it('extracts calls', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    const callNames = result.calls.map(c => c.calleeName);
    expect(callNames).toContain('printf');
  });

  it('generates c: prefixed IDs', () => {
    const result = extractFromFile('main.c', C_CODE, Language.C);
    for (const sym of result.symbols) {
      expect(sym.id).toMatch(/^c:/);
    }
  });
});

// ─── C++ Extraction ─────────────────────────────────────────────

describe('extractFromFile: C++', () => {
  const CPP_CODE = `
#include <iostream>
#include <vector>

namespace shapes {

class Shape {
public:
    virtual double area() = 0;
};

class Circle : public Shape {
public:
    Circle(double r) : radius(r) {}
    double area() { return 3.14 * radius * radius; }
private:
    double radius;
};

enum class Color { Red, Green, Blue };

}

void print_area(shapes::Shape& s) {
    std::cout << s.area() << std::endl;
}
`;

  it('extracts class definitions', () => {
    const result = extractFromFile('shapes.cpp', CPP_CODE, Language.Cpp);
    const classes = result.symbols.filter(s => s.type === NodeType.Class);
    const names = classes.map(s => s.name);
    expect(names).toContain('Shape');
    expect(names).toContain('Circle');
  });

  it('extracts namespace as Package', () => {
    const result = extractFromFile('shapes.cpp', CPP_CODE, Language.Cpp);
    const pkgs = result.symbols.filter(s => s.type === NodeType.Package);
    expect(pkgs.map(s => s.name)).toContain('shapes');
  });

  it('extracts enum definitions', () => {
    const result = extractFromFile('shapes.cpp', CPP_CODE, Language.Cpp);
    const enums = result.symbols.filter(s => s.type === NodeType.Enum);
    expect(enums.map(s => s.name)).toContain('Color');
  });

  it('extracts function definitions', () => {
    const result = extractFromFile('shapes.cpp', CPP_CODE, Language.Cpp);
    const funcs = result.symbols.filter(s => s.type === NodeType.Function);
    expect(funcs.map(s => s.name)).toContain('print_area');
  });

  it('extracts class inheritance', () => {
    const result = extractFromFile('shapes.cpp', CPP_CODE, Language.Cpp);
    const ext = result.heritage.filter(h => h.kind === 'extends');
    expect(ext.length).toBe(1);
    expect(ext[0].childName).toBe('Circle');
    expect(ext[0].parentName).toBe('Shape');
  });

  it('generates cpp: prefixed IDs', () => {
    const result = extractFromFile('shapes.cpp', CPP_CODE, Language.Cpp);
    for (const sym of result.symbols) {
      expect(sym.id).toMatch(/^cpp:/);
    }
  });
});

// ─── Graph Construction ─────────────────────────────────────────

describe('buildGraphFromExtractions', () => {
  function makePythonExtraction(): Map<string, FileExtractionResult> {
    const map = new Map<string, FileExtractionResult>();

    map.set('models.py', extractFromFile('models.py', `
class Animal:
    def speak(self):
        pass

class Dog(Animal):
    def speak(self):
        return "Woof"
`, Language.Python));

    map.set('main.py', extractFromFile('main.py', `
from models import Dog

def main():
    dog = Dog("Rex")
    dog.speak()
`, Language.Python));

    return map;
  }

  it('creates nodes from symbols', () => {
    const extractions = makePythonExtraction();
    const result = buildGraphFromExtractions(extractions);
    expect(result.nodes.length).toBeGreaterThan(0);
    const names = result.nodes.map(n => n.name);
    expect(names).toContain('Animal');
    expect(names).toContain('Dog');
    expect(names).toContain('main');
  });

  it('creates CALLS relationships', () => {
    const extractions = makePythonExtraction();
    const result = buildGraphFromExtractions(extractions);
    const calls = result.relationships.filter(r => r.type === RelationshipType.CALLS);
    // main() calls Dog()
    const dogCall = calls.find(c => {
      const target = result.nodes.find(n => n.id === c.targetId);
      return target?.name === 'Dog';
    });
    expect(dogCall).toBeDefined();
  });

  it('creates EXTENDS relationships from heritage', () => {
    const extractions = makePythonExtraction();
    const result = buildGraphFromExtractions(extractions);
    const extends_ = result.relationships.filter(r => r.type === RelationshipType.EXTENDS);
    expect(extends_.length).toBe(1);

    const child = result.nodes.find(n => n.id === extends_[0].sourceId);
    const parent = result.nodes.find(n => n.id === extends_[0].targetId);
    expect(child?.name).toBe('Dog');
    expect(parent?.name).toBe('Animal');
  });

  it('sets correct confidence levels', () => {
    const extractions = makePythonExtraction();
    const result = buildGraphFromExtractions(extractions);

    // Cross-file call to a GLOBALLY-UNIQUE name with no import edge resolves at 0.4 (sole definition,
    // kept BELOW the process.ts trace threshold). Precision change: a NON-unique name with no local def
    // and no import evidence is now AMBIGUOUS and skipped entirely (no edge) — see the resolution
    // precedence in buildGraphFromExtractions (same-file 0.7 → import 1.0 → unique 0.4 → else skip).
    const calls = result.relationships.filter(r => r.type === RelationshipType.CALLS);
    for (const call of calls) {
      expect(call.confidence).toBe(0.4);
    }

    const extends_ = result.relationships.filter(r => r.type === RelationshipType.EXTENDS);
    for (const ext of extends_) {
      expect(ext.confidence).toBe(0.9);
    }
  });

  it('handles empty extractions', () => {
    const empty = new Map<string, FileExtractionResult>();
    const result = buildGraphFromExtractions(empty);
    expect(result.nodes).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
  });
});

// ─── Cross-Language Consistency ─────────────────────────────────

describe('cross-language consistency', () => {
  it('all extracted symbols have required Node fields', () => {
    const samples: [string, string, Language][] = [
      ['test.py', 'def hello(): pass', Language.Python],
      ['test.rs', 'fn hello() {}', Language.Rust],
      ['test.java', 'class Hello { void greet() {} }', Language.Java],
      ['test.c', 'void hello() {}', Language.C],
      ['test.cpp', 'void hello() {}', Language.Cpp],
    ];

    for (const [file, code, lang] of samples) {
      const result = extractFromFile(file, code, lang);
      expect(result.symbols.length).toBeGreaterThan(0);
      for (const sym of result.symbols) {
        expect(sym.id).toBeTruthy();
        expect(sym.name).toBeTruthy();
        expect(sym.type).toBeTruthy();
        expect(sym.file).toBe(file);
        expect(sym.startLine).toBeGreaterThan(0);
        expect(sym.language).toBe(lang);
      }
    }
  });
});

// ─── AST Fingerprint (sync-02) ──────────────────────────────────
//
// A per-symbol fingerprint computed from the tree-sitter AST STRUCTURE (not a raw
// text hash): a body/signature edit trips it; reformatting (whitespace/indentation)
// or a comment edit does not. Tested at the public extractFromFile / buildGraph seam.

describe('extractFromFile: AST fingerprint (sync-02)', () => {
  // The fingerprint of the symbol named `name` extracted from `code`.
  const fpOf = (file: string, code: string, lang: Language, name: string): string | undefined =>
    extractFromFile(file, code, lang).symbols.find(s => s.name === name)?.fingerprint;

  // AC1 — a code symbol carries a fingerprint derived from its AST.
  it('AC1: a function symbol carries a non-empty fingerprint string', () => {
    const fp = fpOf('f.js', `function add(a, b) { return a + b; }`, Language.JavaScript, 'add');
    expect(typeof fp).toBe('string');
    expect(fp).toBeTruthy();
  });

  // AC1 — structural, NOT a raw-text hash: two reformat-equivalent (text-different)
  // sources must hash to the SAME fingerprint (a text hash would differ).
  it('AC1: the fingerprint is structural, not a raw-text hash', () => {
    const denseSrc = `function add(a,b){return a+b;}`;
    const spacedSrc = `function add(a, b) {\n    return a + b;\n}`;
    expect(denseSrc).not.toBe(spacedSrc); // raw text differs
    const dense = fpOf('f.js', denseSrc, Language.JavaScript, 'add');
    const spaced = fpOf('f.js', spacedSrc, Language.JavaScript, 'add');
    expect(dense).toBeTruthy();
    expect(dense).toBe(spaced); // structural fingerprint identical
  });

  // AC2 — editing the body changes the fingerprint (operator).
  it('AC2: changing the body operator (a + b → a - b) changes the fingerprint', () => {
    const a = fpOf('f.js', `function add(a, b) { return a + b; }`, Language.JavaScript, 'add');
    const b = fpOf('f.js', `function add(a, b) { return a - b; }`, Language.JavaScript, 'add');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  // AC2 — editing the body changes the fingerprint (literal value).
  it('AC2: changing a body literal (return 1 → return 2) changes the fingerprint', () => {
    const a = fpOf('f.js', `function answer() { return 1; }`, Language.JavaScript, 'answer');
    const b = fpOf('f.js', `function answer() { return 2; }`, Language.JavaScript, 'answer');
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  // AC2 — editing the SIGNATURE changes the fingerprint.
  it('AC2: changing the signature (adding a parameter) changes the fingerprint', () => {
    const a = fpOf('f.js', `function add(a, b) { return a; }`, Language.JavaScript, 'add');
    const b = fpOf('f.js', `function add(a, b, c) { return a; }`, Language.JavaScript, 'add');
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  // AC3 — reformatting (whitespace/indentation) leaves the fingerprint stable.
  it('AC3: reformatting (whitespace/indentation) leaves the fingerprint stable', () => {
    const dense = fpOf('f.js', `function add(a,b){return a+b;}`, Language.JavaScript, 'add');
    const spaced = fpOf(
      'f.js',
      `function add(a, b) {\n\n    return a  +  b;\n\n}`,
      Language.JavaScript,
      'add',
    );
    expect(dense).toBeTruthy();
    expect(spaced).toBeTruthy();
    expect(dense).toBe(spaced);
  });

  // AC3 — a comment inside the symbol leaves the fingerprint stable.
  it('AC3: adding a comment inside the body leaves the fingerprint stable', () => {
    const plain = fpOf('f.js', `function add(a, b) { return a + b; }`, Language.JavaScript, 'add');
    const commented = fpOf(
      'f.js',
      `function add(a, b) {\n  // sum the two inputs\n  return a + b; // result\n}`,
      Language.JavaScript,
      'add',
    );
    expect(plain).toBeTruthy();
    expect(commented).toBeTruthy();
    expect(plain).toBe(commented);
  });

  // AC4 — deterministic: same source → same fingerprint on repeated extraction.
  it('AC4: the same source yields the same fingerprint on repeated extraction', () => {
    const src = `function add(a, b) { return a + b; }`;
    const a = fpOf('f.js', src, Language.JavaScript, 'add');
    const b = fpOf('f.js', src, Language.JavaScript, 'add');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  // AC4 — position-independent: the same symbol body at a different position (and in
  // a different file) yields the same fingerprint (proves it's a pure function of AST
  // structure, the basis for stability across runs/processes).
  it('AC4: the fingerprint is position-independent (same body, shifted position)', () => {
    const a = fpOf('a.js', `function add(a, b) { return a + b; }`, Language.JavaScript, 'add');
    const b = fpOf('b.js', `const z = 0;\n\nfunction add(a, b) { return a + b; }`, Language.JavaScript, 'add');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  // AC5 — computed at index time for every supported language (no throw).
  it('AC5: every supported language yields a fingerprint for its function symbol', () => {
    const cases: [string, string, Language, string][] = [
      ['m.py', 'def hello():\n    return 1\n', Language.Python, 'hello'],
      ['l.rs', 'fn hello() -> i32 { 1 }', Language.Rust, 'hello'],
      ['M.java', 'class M { void hello() { int x = 1; } }', Language.Java, 'hello'],
      ['m.c', 'int hello() { return 1; }', Language.C, 'hello'],
      ['m.cpp', 'int hello() { return 1; }', Language.Cpp, 'hello'],
      ['m.cjs', 'function hello() { return 1; }', Language.JavaScript, 'hello'],
    ];
    for (const [file, code, lang, name] of cases) {
      const fp = fpOf(file, code, lang, name);
      expect(fp, `${lang}:${name}`).toBeTruthy();
      expect(typeof fp).toBe('string');
    }
  });

  // AC5 — absent gracefully: a symbol with no fingerprint threads through graph
  // construction with the field ABSENT (not a null/undefined value) and no throw.
  it('AC5: a symbol lacking a fingerprint yields a node with the field absent (no throw)', () => {
    const sym: ExtractedSymbol = {
      id: 'x:func:f.x:noBody',
      name: 'noBody',
      type: NodeType.Function,
      file: 'f.x',
      startLine: 1,
      endLine: 1,
      language: Language.JavaScript,
      package: '',
      exported: true,
      // no fingerprint
    };
    const map = new Map<string, FileExtractionResult>([
      ['f.x', { symbols: [sym], calls: [], imports: [], heritage: [] }],
    ]);
    let result!: ReturnType<typeof buildGraphFromExtractions>;
    expect(() => { result = buildGraphFromExtractions(map); }).not.toThrow();
    const node = result.nodes.find(n => n.id === sym.id);
    expect(node).toBeDefined();
    expect('fingerprint' in node!).toBe(false);
  });

  // The fingerprint reaches the graph Node (threaded through buildGraphFromExtractions).
  it('threads the fingerprint onto the graph Node', () => {
    const map = new Map<string, FileExtractionResult>([
      ['f.cjs', extractFromFile('f.cjs', `function add(a, b) { return a + b; }`, Language.JavaScript)],
    ]);
    const result = buildGraphFromExtractions(map);
    const node = result.nodes.find(n => n.name === 'add');
    expect(node).toBeDefined();
    expect(typeof node!.fingerprint).toBe('string');
    expect(node!.fingerprint).toBeTruthy();
  });
});

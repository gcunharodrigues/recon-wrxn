/**
 * Tree-sitter Symbol Extractor
 *
 * Parses source files with tree-sitter, runs S-expression queries,
 * and produces recon-wrxn graph nodes + relationships.
 */

import Parser from 'tree-sitter';
import path from 'node:path';
import { NodeType, RelationshipType, Language } from '../../graph/types.js';
import type { Node, Relationship } from '../../graph/types.js';
import type { AnalyzerResult } from '../types.js';
import { LANGUAGE_QUERIES } from './queries.js';
import { setParserLanguage, isLanguageAvailable, getLanguageForFile } from './parser.js';

// ─── Test File Detection ────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /_test\.[tj]sx?$/,
  /[\\/]__tests__[\\/]/,
  /[\\/]test[\\/]/,
];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(filePath));
}

// ─── ID Prefixes ────────────────────────────────────────────────

const LANG_PREFIX: Record<Language, string> = {
  [Language.Python]: 'py',
  [Language.Rust]: 'rs',
  [Language.Java]: 'java',
  [Language.C]: 'c',
  [Language.Cpp]: 'cpp',
  [Language.Go]: 'go',
  [Language.TypeScript]: 'ts',
  [Language.Tsx]: 'ts',
  [Language.Ruby]: 'rb',
  [Language.PHP]: 'php',
  [Language.CSharp]: 'cs',
  [Language.Kotlin]: 'kt',
  [Language.Swift]: 'swift',
  [Language.JavaScript]: 'js',
  [Language.Markdown]: 'md',
  // Multi-format Source langs (multiformat-distill-01): the Source analyzer mints
  // its own `source:<file>` ids, so these prefixes are unused by tree-sitter —
  // present only to keep this Record<Language> exhaustive.
  [Language.Html]: 'html',
  [Language.Text]: 'txt',
  [Language.Pdf]: 'pdf',
  [Language.Docx]: 'docx',
  [Language.Pptx]: 'pptx',
  [Language.Xlsx]: 'xlsx',
};

// ─── Capture → NodeType Mapping ─────────────────────────────────

function captureToNodeType(captureMap: Record<string, unknown>): NodeType | null {
  if (captureMap['definition.function']) return NodeType.Function;
  if (captureMap['definition.class']) return NodeType.Class;
  if (captureMap['definition.struct']) return NodeType.Struct;
  if (captureMap['definition.interface']) return NodeType.Interface;
  if (captureMap['definition.method']) return NodeType.Method;
  if (captureMap['definition.constructor']) return NodeType.Method;
  if (captureMap['definition.enum']) return NodeType.Enum;
  if (captureMap['definition.trait']) return NodeType.Trait;
  if (captureMap['definition.impl']) return NodeType.Struct; // impl block → associated struct
  if (captureMap['definition.module']) return NodeType.Module;
  if (captureMap['definition.namespace']) return NodeType.Package;
  if (captureMap['definition.type']) return NodeType.Type;
  if (captureMap['definition.typedef']) return NodeType.Type;
  if (captureMap['definition.const']) return NodeType.Function; // treat as callable
  if (captureMap['definition.static']) return NodeType.Function;
  if (captureMap['definition.macro']) return NodeType.Function;
  if (captureMap['definition.union']) return NodeType.Struct;
  return null;
}

// ─── Export Detection ───────────────────────────────────────────

function isExported(name: string, language: Language, node?: any): boolean {
  switch (language) {
    case Language.Python:
      // Python: not starting with _ is public
      return !name.startsWith('_');
    case Language.Rust:
      // Rust: check for pub keyword in parent
      if (node?.parent?.type === 'visibility_modifier') return true;
      if (node?.parent?.children) {
        for (const child of node.parent.children) {
          if (child.type === 'visibility_modifier') return true;
        }
      }
      // Functions at module level starting with pub
      const parentText = node?.parent?.text?.slice(0, 20) || '';
      return parentText.startsWith('pub ') || parentText.startsWith('pub(');
    case Language.Java:
      // Java: check for public modifier
      if (node?.parent?.children) {
        for (const child of node.parent.children) {
          if (child.type === 'modifiers') {
            return child.text?.includes('public') ?? false;
          }
        }
      }
      return true; // default to exported for classes
    case Language.C:
    case Language.Cpp:
      // C/C++: everything in a header is exported, non-static in .c files
      return true;
    case Language.JavaScript:
      // CommonJS has no `export` keyword on the declaration; everything is a
      // potential export (module.exports / exports.x). Default to true.
      return true;
    case Language.Ruby:
      // Ruby: methods starting with _ are private by convention
      return !name.startsWith('_');
    case Language.PHP:
      // PHP: check for public/protected/private keywords
      if (node?.parent?.children) {
        for (const child of node.parent.children) {
          if (child.type === 'visibility_modifier') {
            return child.text === 'public';
          }
        }
      }
      return true; // default to exported
    case Language.CSharp:
      // C#: check for public modifier
      if (node?.parent?.children) {
        for (const child of node.parent.children) {
          if (child.type === 'modifier') {
            if (child.text === 'private' || child.text === 'internal') return false;
          }
        }
      }
      return true;
    case Language.Kotlin:
      // Kotlin: check for private/internal modifiers
      if (node?.parent?.children) {
        for (const child of node.parent.children) {
          if (child.type === 'visibility_modifier') {
            return child.text === 'public' || child.text === undefined;
          }
        }
      }
      return true; // default public in Kotlin
    case Language.Swift:
      // Swift: check for access modifiers
      if (node?.parent?.children) {
        for (const child of node.parent.children) {
          if (child.type === 'modifiers') {
            if (child.text?.includes('private') || child.text?.includes('fileprivate')) return false;
          }
        }
      }
      return true;
    default:
      return true;
  }
}

// ─── Package/Directory Detection ────────────────────────────────

function getPackage(filePath: string, language: Language): string {
  // Use the directory as the "package"
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) {
    const lastBackslash = filePath.lastIndexOf('\\');
    if (lastBackslash === -1) return '';
    return filePath.slice(0, lastBackslash).replace(/\\/g, '/');
  }
  return filePath.slice(0, lastSlash);
}

// ─── Main Extraction ────────────────────────────────────────────

export interface ExtractedSymbol {
  id: string;
  name: string;
  type: NodeType;
  file: string;
  startLine: number;
  endLine: number;
  language: Language;
  package: string;
  exported: boolean;
  isTest?: boolean;
  decorators?: string[];
}

export interface ExtractedCall {
  callerFile: string;
  calleeName: string;
  line: number;
}

export interface ExtractedImport {
  file: string;
  source: string;
  line: number;
}

export interface ExtractedHeritage {
  childName: string;
  childFile: string;
  parentName: string;
  kind: 'extends' | 'implements' | 'trait';
}

export interface FileExtractionResult {
  symbols: ExtractedSymbol[];
  calls: ExtractedCall[];
  imports: ExtractedImport[];
  heritage: ExtractedHeritage[];
}

/**
 * Extract symbols, calls, imports, and heritage from a single file.
 */
export function extractFromFile(
  filePath: string,
  content: string,
  language: Language,
): FileExtractionResult {
  if (!isLanguageAvailable(language)) {
    return { symbols: [], calls: [], imports: [], heritage: [] };
  }

  const queryString = LANGUAGE_QUERIES[language];
  if (!queryString) {
    return { symbols: [], calls: [], imports: [], heritage: [] };
  }

  const parser = setParserLanguage(language);
  // node-tree-sitter@0.21's parser.parse(string) throws "Invalid argument"
  // when content exceeds ~32767 bytes. Raise the internal parse buffer well
  // above any realistic source size so files >32KB (e.g. a 51KB .cjs) parse.
  // bufferSize is the THIRD arg; the 2nd (oldTree) stays undefined = no
  // incremental reuse, identical behavior to before for files under the old
  // limit (the native binding treats undefined as "no old tree"). [Story 5.6]
  const tree = parser.parse(content, undefined, { bufferSize: 1024 * 1024 });

  let query: Parser.Query;
  let matches: Parser.QueryMatch[];
  try {
    query = new Parser.Query(parser.getLanguage(), queryString);
    matches = query.matches(tree.rootNode);
  } catch {
    return { symbols: [], calls: [], imports: [], heritage: [] };
  }

  const prefix = LANG_PREFIX[language] || language;
  const pkg = getPackage(filePath, language);
  const fileIsTest = isTestFile(filePath);
  const symbols: ExtractedSymbol[] = [];
  const calls: ExtractedCall[] = [];
  const imports: ExtractedImport[] = [];
  const heritage: ExtractedHeritage[] = [];
  const seenDefs = new Set<string>();
  const seenHeritage = new Set<string>();
  // Track decorators/annotations: store by 0-based row of the annotation itself
  interface AnnotationInfo { name: string; row: number; }
  const pendingAnnotations: AnnotationInfo[] = [];
  // Track test attribute rows (0-based)
  const testAttrRows = new Set<number>();
  // Python decorators: keyed by the decorated definition's name-node start row (0-based)
  const pyDecoratorsByNameRow = new Map<number, string[]>();

  // First pass: collect decorators, annotations, and test attributes
  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    for (const c of match.captures) {
      captureMap[c.name] = c.node;
    }

    // Python decorators — directly tied to the decorated definition's name node
    if (captureMap['decorator'] && captureMap['decorator.name']) {
      const decoratorName = captureMap['decorator.name'].text;
      const decoratedName = captureMap['decorated.func.name'] || captureMap['decorated.class.name'];
      if (decoratedName) {
        const nameRow = decoratedName.startPosition.row;
        if (!pyDecoratorsByNameRow.has(nameRow)) pyDecoratorsByNameRow.set(nameRow, []);
        pyDecoratorsByNameRow.get(nameRow)!.push(decoratorName);
      }
    }

    // Java/C#/PHP/Kotlin annotations — store the annotation's own row
    if (captureMap['annotation'] && captureMap['annotation.name']) {
      const annotationName = captureMap['annotation.name'].text;
      const annotationNode = captureMap['annotation'];
      const row = annotationNode.startPosition.row;
      pendingAnnotations.push({ name: annotationName, row });

      if (annotationName === 'Test' || annotationName === 'test') {
        testAttrRows.add(row);
      }
    }

    // Rust #[test] attribute — store the attribute's own row
    if (captureMap['attribute'] && captureMap['attr.name']) {
      const attrName = captureMap['attr.name'].text;
      if (attrName === 'test') {
        testAttrRows.add(captureMap['attribute'].startPosition.row);
      }
    }
  }

  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    for (const c of match.captures) {
      captureMap[c.name] = c.node;
    }

    // ── Skip decorator/annotation/attribute matches (handled in first pass) ──
    if (captureMap['decorator'] || captureMap['annotation'] || captureMap['attribute']) {
      continue;
    }

    // ── Imports ──
    if (captureMap['import'] && captureMap['import.source']) {
      const sourceNode = captureMap['import.source'];
      imports.push({
        file: filePath,
        source: sourceNode.text.replace(/['"]/g, ''),
        line: sourceNode.startPosition.row + 1,
      });
      continue;
    }

    // ── Calls ──
    if (captureMap['call'] && captureMap['call.name'] && !captureMap['name']) {
      const callNode = captureMap['call.name'];
      calls.push({
        callerFile: filePath,
        calleeName: callNode.text,
        line: callNode.startPosition.row + 1,
      });
      continue;
    }

    // ── Heritage ──
    if (captureMap['heritage.class'] && (captureMap['heritage.extends'] || captureMap['heritage.implements'] || captureMap['heritage.trait'])) {
      const childName = captureMap['heritage.class'].text;
      if (captureMap['heritage.extends']) {
        const hKey = `${childName}:extends:${captureMap['heritage.extends'].text}`;
        if (!seenHeritage.has(hKey)) {
          seenHeritage.add(hKey);
          heritage.push({
            childName,
            childFile: filePath,
            parentName: captureMap['heritage.extends'].text,
            kind: 'extends',
          });
        }
      }
      if (captureMap['heritage.implements']) {
        const hKey = `${childName}:implements:${captureMap['heritage.implements'].text}`;
        if (!seenHeritage.has(hKey)) {
          seenHeritage.add(hKey);
          heritage.push({
            childName,
            childFile: filePath,
            parentName: captureMap['heritage.implements'].text,
            kind: 'implements',
          });
        }
      }
      if (captureMap['heritage.trait']) {
        const hKey = `${childName}:trait:${captureMap['heritage.trait'].text}`;
        if (!seenHeritage.has(hKey)) {
          seenHeritage.add(hKey);
          heritage.push({
            childName,
            childFile: filePath,
            parentName: captureMap['heritage.trait'].text,
            kind: 'trait',
          });
        }
      }
      // Heritage match may also define the symbol — fall through if @name exists
      if (!captureMap['name']) continue;
    }

    // ── Definitions ──
    const nameNode = captureMap['name'];
    if (!nameNode) continue;

    const nodeType = captureToNodeType(captureMap);
    if (!nodeType) continue;

    const name = nameNode.text;
    const defNode = getDefinitionNode(captureMap);
    const startLine = defNode ? defNode.startPosition.row + 1 : nameNode.startPosition.row + 1;
    const endLine = defNode ? defNode.endPosition.row + 1 : startLine;

    // Deduplicate (same name+line can match multiple query patterns)
    const dedupKey = `${name}:${startLine}`;
    if (seenDefs.has(dedupKey)) continue;
    seenDefs.add(dedupKey);

    // Position-free base id (BL-070 R1): omit startLine so edits ABOVE a symbol
    // don't re-key it. Collisions within the same file are disambiguated by a
    // source-order ordinal `~N` in the post-pass below.
    const id = `${prefix}:${nodeTypeToIdSegment(nodeType)}:${filePath}:${name}`;

    // Check for Python decorators (matched by name node row)
    const pyDecorators = pyDecoratorsByNameRow.get(nameNode.startPosition.row);

    // Check for annotations/attributes that belong to this definition.
    // An annotation belongs to a definition if:
    //   - It is on a line within the definition range (inside the node), OR
    //   - It is on a line immediately preceding the definition start (sibling attribute)
    // We only attach to the narrowest definition that satisfies these conditions,
    // which we approximate by checking that the name row matches closely.
    const defStartRow = defNode ? defNode.startPosition.row : nameNode.startPosition.row;
    const nameStartRow = nameNode.startPosition.row;
    const matchedAnnotations: string[] = [];
    let isTestMarked = false;
    for (const ann of pendingAnnotations) {
      // Annotation is inside definition range OR immediately preceding the name
      const isInside = ann.row >= defStartRow && ann.row <= nameStartRow;
      if (isInside) {
        matchedAnnotations.push(ann.name);
      }
    }
    // Check test attributes (Rust #[test]) — same logic
    for (const testRow of testAttrRows) {
      const isInside = testRow >= defStartRow - 1 && testRow <= nameStartRow;
      if (isInside) {
        isTestMarked = true;
        break;
      }
    }

    const attachedDecorators = pyDecorators
      ? [...pyDecorators, ...matchedAnnotations]
      : matchedAnnotations.length > 0 ? matchedAnnotations : undefined;
    const symbolIsTest = fileIsTest || isTestMarked;

    symbols.push({
      id,
      name,
      type: nodeType,
      file: filePath,
      startLine,
      endLine,
      language,
      package: pkg,
      exported: isExported(name, language, defNode || nameNode),
      ...(symbolIsTest ? { isTest: true } : {}),
      ...(attachedDecorators && attachedDecorators.length > 0 ? { decorators: [...attachedDecorators] } : {}),
    });
  }

  // ── Position-free id collision disambiguation (BL-070 R1) ──
  // The base id drops startLine, so two symbols in the same file can collide
  // (measured ~1.78% — e.g. multiple classes' `constructor` methods in one
  // file). For each colliding group, sort by startLine ascending and append a
  // stable source-order ordinal `~0`, `~1`, … Single-member groups keep the
  // bare base id (no suffix), preserving the position-free property.
  const byId = new Map<string, ExtractedSymbol[]>();
  for (const s of symbols) {
    const group = byId.get(s.id);
    if (group) group.push(s);
    else byId.set(s.id, [s]);
  }
  for (const [base, group] of byId) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.startLine - b.startLine);
    group.forEach((s, i) => {
      s.id = `${base}~${i}`;
    });
  }

  return { symbols, calls, imports, heritage };
}

/**
 * Build graph nodes and relationships from extracted file data.
 */
export function buildGraphFromExtractions(
  files: Map<string, FileExtractionResult>,
): AnalyzerResult {
  const nodes: Node[] = [];
  const relationships: Relationship[] = [];
  const symbolsByName = new Map<string, ExtractedSymbol[]>();
  const seenImports = new Set<string>();

  // Pass 1: Create nodes and build name index
  for (const [filePath, result] of files) {
    for (const sym of result.symbols) {
      nodes.push({
        id: sym.id,
        type: sym.type,
        name: sym.name,
        file: sym.file,
        startLine: sym.startLine,
        endLine: sym.endLine,
        language: sym.language,
        package: sym.package,
        exported: sym.exported,
        ...(sym.isTest ? { isTest: true } : {}),
      });

      if (!symbolsByName.has(sym.name)) {
        symbolsByName.set(sym.name, []);
      }
      symbolsByName.get(sym.name)!.push(sym);
    }
  }

  // Build import map: callerFile → Set of imported TARGET FILE PATHS (resolved).
  // CRITICAL: resolve each raw require specifier (e.g. './lock') to the indexed file it
  // points at (e.g. 'tools/lock.cjs') via resolveCjsImport — the SAME resolver Pass 5 uses
  // for IMPORTS edges. Storing raw `imp.source` here (the old behavior) meant the CALLS
  // confidence check `callerImports.has(target.file)` could NEVER match (a require string is
  // not a file path), so every cross-file call collapsed to the low-confidence path and real
  // import-corroborated callers were indistinguishable from same-name collisions.
  const importsByFile = new Map<string, Set<string>>();
  for (const [filePath, result] of files) {
    const targetFiles = new Set<string>();
    for (const imp of result.imports) {
      const resolved = resolveCjsImport(imp.source, filePath, files);
      if (resolved) targetFiles.add(resolved);
    }
    importsByFile.set(filePath, targetFiles);
  }

  // Pass 2: Resolve calls to CALLS relationships
  for (const [filePath, result] of files) {
    // Find caller symbols in this file
    const fileSymbols = result.symbols;
    const callerImports = importsByFile.get(filePath) ?? new Set<string>();

    for (const call of result.calls) {
      const targets = symbolsByName.get(call.calleeName);
      if (!targets || targets.length === 0) continue;

      // Find the enclosing function for this call
      const caller = findEnclosingSymbol(fileSymbols, call.line);
      if (!caller) continue;

      // Resolution precedence — PRECISION over recall, to avoid name-collision false edges.
      // A bare call `add(x)` must NOT silently resolve to some unrelated file's `add` just because
      // it lives in a different file (the old `find(t => t.file !== filePath)` did exactly that,
      // manufacturing thousands of bogus cross-file CALLS for common helper names — `add`/`main`/
      // `esc` — once the graph grew). Resolve in order of evidence:
      //   1. same-file definition (local call)                          → 0.7
      //   2. cross-file definition whose file the caller imports         → 1.0
      //   3. globally UNIQUE name (sole definition anywhere)             → 0.5
      //   4. otherwise (non-unique name, no local, no import evidence)   → AMBIGUOUS, skip (no edge)
      const localTarget = targets.find(t => t.file === filePath);
      const importedTarget = targets.find(t => t.file !== filePath && callerImports.has(t.file));
      let target: ExtractedSymbol;
      let confidence: number;
      if (localTarget) {
        target = localTarget;
        confidence = 0.7;
      } else if (importedTarget) {
        target = importedTarget;
        confidence = 1.0;
      } else if (targets.length === 1) {
        target = targets[0];
        // 0.4 (NOT 0.5) is deliberate: it stays BELOW process.ts minTraceConfidence (0.5) so a
        // unique-name cross-file edge with no resolved import is recorded but does NOT enter
        // flow-tracing (detectProcesses → recon flows) — preserving pre-change flow behavior.
        // NOTE: recon_explain (callers/callees) + recon_impact render ALL CALLS edges regardless of
        // confidence, so these edges DO appear there; the push hook is the only consumer that gates
        // (>=1.0). So this value governs flow-trace inclusion specifically, not blanket visibility.
        confidence = 0.4;
      } else {
        continue; // ambiguous: same name in multiple files, no local def, no import evidence → don't guess
      }
      if (target.id === caller.id) continue; // skip self-calls

      const relId = `${caller.id}-CALLS-${target.id}`;
      relationships.push({
        id: relId,
        type: RelationshipType.CALLS,
        sourceId: caller.id,
        targetId: target.id,
        confidence,
      });
    }
  }

  // Pass 3: Heritage → EXTENDS / IMPLEMENTS relationships
  for (const [, result] of files) {
    for (const h of result.heritage) {
      const children = symbolsByName.get(h.childName);
      const parents = symbolsByName.get(h.parentName);
      if (!children || !parents) continue;

      const child = children.find(s => s.file === h.childFile) || children[0];
      const parent = parents[0];

      const relType = h.kind === 'extends'
        ? RelationshipType.EXTENDS
        : RelationshipType.IMPLEMENTS;

      relationships.push({
        id: `${child.id}-${relType}-${parent.id}`,
        type: relType,
        sourceId: child.id,
        targetId: parent.id,
        confidence: 0.9,
      });
    }
  }

  // Pass 4: Method → Class HAS_METHOD relationships
  for (const [, result] of files) {
    const methods = result.symbols.filter(
      s => s.type === NodeType.Method,
    );
    const classes = result.symbols.filter(
      s => s.type === NodeType.Class || s.type === NodeType.Struct || s.type === NodeType.Trait,
    );

    if (classes.length === 0 || methods.length === 0) continue;

    for (const method of methods) {
      // Find the closest enclosing class (the class whose range contains this method)
      const enclosing = classes.find(
        c => c.startLine <= method.startLine && c.endLine >= method.endLine,
      );
      if (!enclosing) continue;

      relationships.push({
        id: `${enclosing.id}-HAS_METHOD-${method.id}`,
        type: RelationshipType.HAS_METHOD,
        sourceId: enclosing.id,
        targetId: method.id,
        confidence: 1.0,
      });
    }
  }

  // Pass 5: ES/CJS import → File→File IMPORTS edges (Slice B2)
  //
  // NET-NEW construction. The tree-sitter path emits no File nodes and no
  // IMPORTS edges for most languages; this pass adds both, GATED to the
  // JS/TS module family (JavaScript, TypeScript, Tsx). The gate is the
  // no-regression control: python/go/rust/java/c/cpp/ruby/php/csharp (which
  // also populate imports[]) would gain incorrect File nodes + IMPORTS edges
  // and break the existing-language graph-shape assertions. TS/TSX are included
  // because the compiler-API TS path (now removed) produced `ts:file:` File
  // nodes + IMPORTS; routing TS through tree-sitter must preserve that. Node
  // ids/language are stamped per the file's OWN language (LANG_PREFIX), so JS
  // files stay byte-identical (`js:file:`) while .ts/.tsx get `ts:file:`.
  // Modeled on ts-analyzer.resolveImportPath / tryResolveFile, but resolution
  // is against the `files` Map keys (project-relative, forward-slash — see
  // analyzer.ts relativePath contract), NOT the filesystem.
  const importEdgeLanguages = new Set<Language>([
    Language.JavaScript, Language.TypeScript, Language.Tsx,
  ]);
  const jsFileNodeIds = new Map<string, string>(); // relativePath → File node id
  const jsImportPairs: Array<[string, string]> = []; // [fromRel, toRel] resolved imports (for Pass 6)
  const ensureFileNode = (relPath: string): string => {
    const existing = jsFileNodeIds.get(relPath);
    if (existing) return existing;
    const lang = getLanguageForFile(relPath) ?? Language.JavaScript;
    const id = `${LANG_PREFIX[lang]}:file:${relPath}`;
    jsFileNodeIds.set(relPath, id);
    // Field parity with the TS-Compiler path's File nodes (ts-analyzer.ts L590)
    // so downstream consumers (recon_impact, rules.ts orphans/circular_deps)
    // treat these File nodes identically: name = basename, exported = true,
    // 0/0 lines, package = directory.
    nodes.push({
      id,
      type: NodeType.File,
      name: relPath.split('/').pop() || relPath,
      file: relPath,
      startLine: 0,
      endLine: 0,
      language: lang,
      package: getPackage(relPath, lang),
      exported: true,
      ...(isTestFile(relPath) ? { isTest: true } : {}),
    });
    return id;
  };

  for (const [filePath, result] of files) {
    // GATE — JS/TS module family only (the make-or-break no-regression control).
    const fileLang = getLanguageForFile(filePath);
    if (!fileLang || !importEdgeLanguages.has(fileLang)) continue;

    // Every indexed file gets exactly one File node (idempotent by relPath).
    const fromId = ensureFileNode(filePath);

    for (const imp of result.imports) {
      const resolved = resolveCjsImport(imp.source, filePath, files);
      if (!resolved) continue; // bare specifier, dynamic, or unindexed → no edge
      const toId = ensureFileNode(resolved);
      const relId = `${fromId}-IMPORTS-${toId}`;
      if (seenImports.has(relId)) continue; // dedup duplicate requires of same target
      seenImports.add(relId);
      relationships.push({
        id: relId,
        type: RelationshipType.IMPORTS,
        sourceId: fromId,
        targetId: toId,
        confidence: 1.0,
      });
      jsImportPairs.push([filePath, resolved]);
    }
  }

  // Pass 6: directory-level Package nodes + CONTAINS + Package→Package IMPORTS (BL-041 + BL-042).
  //
  // WHY: recon_map reported "0 packages" and rules.findCircularDeps always returned 0 for JS, because
  // NO analyzer emitted NodeType.Package for *directory* packages (only C++ namespaces produced Package
  // nodes), and findCircularDeps walks ONLY Package↔Package IMPORTS edges — the Pass-5 File→File
  // IMPORTS never reached it. This pass derives one Package node per distinct directory of the JS File
  // nodes, links Package→File via CONTAINS, and LIFTS each cross-directory File→File import to a
  // Package→Package IMPORTS edge, so both the package overview and cycle detection finally see them.
  //
  // JS/TS-family only, mirroring Pass 5's gate: only these build IMPORTS edges today, so only their
  // packages can form import cycles. Other languages have no IMPORTS edges to lift — emitting empty
  // Package nodes for them would be cosmetic in recon_map and would risk the graph-shape regressions
  // Pass 5's gate prevents. The C++ namespace Package nodes use the 5-segment symbol id
  // (`<lang>:pkg:<file>:<name>:<line>`) and are left untouched; these directory packages use the
  // distinct 3-segment `<prefix>:pkg:<dir>` (prefix per the file's language — `js` or `ts`).
  const langForFile = (relPath: string): Language =>
    getLanguageForFile(relPath) ?? Language.JavaScript;
  const pkgNameForFile = (relPath: string): string =>
    getPackage(relPath, langForFile(relPath)) || '.';
  const seenPkgNodes = new Set<string>();
  const ensurePackageNode = (pkgName: string, lang: Language): string => {
    const id = `${LANG_PREFIX[lang]}:pkg:${pkgName}`;
    if (!seenPkgNodes.has(id)) {
      seenPkgNodes.add(id);
      nodes.push({
        id,
        type: NodeType.Package,
        name: pkgName,
        file: pkgName,
        startLine: 0,
        endLine: 0,
        language: lang,
        package: pkgName,
        exported: true,
      });
    }
    return id;
  };

  // One Package node per distinct directory of the File nodes, + Package→File CONTAINS.
  for (const [relPath, fileId] of jsFileNodeIds) {
    const pkgId = ensurePackageNode(pkgNameForFile(relPath), langForFile(relPath));
    relationships.push({
      id: `${pkgId}-CONTAINS-${fileId}`,
      type: RelationshipType.CONTAINS,
      sourceId: pkgId,
      targetId: fileId,
      confidence: 1.0,
    });
  }

  // Lift cross-directory File→File imports to Package→Package IMPORTS (dedup; skip intra-package,
  // which is not a cross-package edge and would create a spurious self-loop / false 1-cycle).
  const seenPkgImports = new Set<string>();
  for (const [fromRel, toRel] of jsImportPairs) {
    const fromPkg = pkgNameForFile(fromRel);
    const toPkg = pkgNameForFile(toRel);
    if (fromPkg === toPkg) continue;
    const fromPkgId = ensurePackageNode(fromPkg, langForFile(fromRel));
    const toPkgId = ensurePackageNode(toPkg, langForFile(toRel));
    const relId = `${fromPkgId}-IMPORTS-${toPkgId}`;
    if (seenPkgImports.has(relId)) continue;
    seenPkgImports.add(relId);
    relationships.push({
      id: relId,
      type: RelationshipType.IMPORTS,
      sourceId: fromPkgId,
      targetId: toPkgId,
      confidence: 1.0,
    });
  }

  return { nodes, relationships };
}

/**
 * Resolve a CommonJS require() specifier to an indexed project file.
 *
 * Mirrors ts-analyzer.tryResolveFile but with CommonJS extensions and resolution
 * against the in-memory `files` Map (the indexed project surface) rather than the
 * filesystem. Returns the project-relative, forward-slash key of the target file,
 * or null when the specifier is non-relative (bare/node-builtin) or resolves to no
 * indexed file.
 */
function resolveCjsImport(
  source: string,
  fromRelPath: string,
  files: Map<string, FileExtractionResult>,
): string | null {
  // Non-relative specifier (bare package, node:builtin) → no internal edge.
  if (!source.startsWith('.')) return null;

  // Resolve against the importing file's directory using POSIX semantics, since
  // the Map keys are already forward-slash project-relative paths.
  const fromDir = path.posix.dirname(fromRelPath);
  const base = path.posix.normalize(path.posix.join(fromDir, source));

  // CJS/ESM/TS candidate ladder (exact first, then extension-suffixed, then index
  // files). TS/TSX extensions are included so ES imports like `from './helpers'`
  // resolve to the indexed `helpers.ts` (TS now flows through this same path).
  const candidates = [
    base,
    base + '.cjs',
    base + '.js',
    base + '.mjs',
    base + '.ts',
    base + '.tsx',
    base + '.mts',
    base + '.cts',
    path.posix.join(base, 'index.cjs'),
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.mjs'),
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

// ─── Helpers ────────────────────────────────────────────────────

function getDefinitionNode(captureMap: Record<string, any>): any | null {
  const defKeys = [
    'definition.function', 'definition.class', 'definition.struct',
    'definition.interface', 'definition.method', 'definition.constructor',
    'definition.enum', 'definition.trait', 'definition.impl',
    'definition.module', 'definition.namespace', 'definition.type',
    'definition.typedef', 'definition.const', 'definition.static',
    'definition.macro', 'definition.union',
  ];
  for (const key of defKeys) {
    if (captureMap[key]) return captureMap[key];
  }
  return null;
}

function nodeTypeToIdSegment(type: NodeType): string {
  switch (type) {
    case NodeType.Function: return 'func';
    case NodeType.Method: return 'method';
    case NodeType.Class: return 'class';
    case NodeType.Struct: return 'struct';
    case NodeType.Interface: return 'iface';
    case NodeType.Enum: return 'enum';
    case NodeType.Trait: return 'trait';
    case NodeType.Module: return 'mod';
    case NodeType.Package: return 'pkg';
    case NodeType.Type: return 'type';
    default: return 'sym';
  }
}

function findEnclosingSymbol(
  symbols: ExtractedSymbol[],
  line: number,
): ExtractedSymbol | null {
  // Find the narrowest function/method containing this line
  let best: ExtractedSymbol | null = null;
  for (const sym of symbols) {
    if (sym.type !== NodeType.Function && sym.type !== NodeType.Method) continue;
    if (sym.startLine <= line && sym.endLine >= line) {
      if (!best || (sym.endLine - sym.startLine) < (best.endLine - best.startLine)) {
        best = sym;
      }
    }
  }
  return best;
}

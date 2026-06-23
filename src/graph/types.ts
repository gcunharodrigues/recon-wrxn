/**
 * Graph Type System
 *
 * Core types for the recon-wrxn knowledge graph.
 * Node ID conventions use namespaced prefixes to avoid collisions:
 *   Go:     go:pkg:, go:file:, go:func:, go:method:, go:struct:, go:iface:
 *   TS:     ts:mod:, ts:file:, ts:comp:, ts:func:, ts:type:
 *   Python: py:file:, py:func:, py:class:, py:method:
 *   Rust:   rs:file:, rs:func:, rs:struct:, rs:trait:, rs:impl:, rs:enum:
 *   Java:   java:file:, java:func:, java:class:, java:iface:, java:enum:
 *   C:      c:file:, c:func:, c:struct:, c:enum:
 *   C++:    cpp:file:, cpp:func:, cpp:class:, cpp:struct:, cpp:enum:
 *   Ruby:   rb:file:, rb:func:, rb:class:, rb:method:
 *   PHP:    php:file:, php:func:, php:class:, php:iface:
 *   C#:     cs:file:, cs:func:, cs:class:, cs:iface:, cs:enum:
 *   Kotlin: kt:file:, kt:func:, kt:class:, kt:iface:, kt:enum:
 *   Swift:  swift:file:, swift:func:, swift:class:, swift:struct:, swift:enum:
 *   JS:     js:file:, js:func:, js:class:, js:method:
 */

// ─── Enums ──────────────────────────────────────────────────────

export enum NodeType {
  Package = 'Package',
  File = 'File',
  Function = 'Function',
  Method = 'Method',
  Struct = 'Struct',
  Interface = 'Interface',
  Module = 'Module',
  Component = 'Component',
  Type = 'Type',
  Class = 'Class',
  Enum = 'Enum',
  Trait = 'Trait',
  Page = 'Page',          // Prose: one whole markdown file
  Section = 'Section',    // Prose: one heading + the body beneath it (primary retrieval unit)
  Source = 'Source',      // Raw source file (html/txt → full searchable; pdf/docx/pptx/xlsx → minimal node, path only)
  SessionEvent = 'SessionEvent', // Session telemetry: one .wrxn/events/*.jsonl record (prompt | tool)
}

export enum RelationshipType {
  CONTAINS = 'CONTAINS',       // Package/Module → File; Page → Section (prose)
  DEFINES = 'DEFINES',         // File → Symbol
  CALLS = 'CALLS',             // Function → Function
  IMPORTS = 'IMPORTS',         // Package → Package
  HAS_METHOD = 'HAS_METHOD',  // Struct/Class → Method
  IMPLEMENTS = 'IMPLEMENTS',   // Struct → Interface / Class → Trait
  USES_COMPONENT = 'USES_COMPONENT', // Component → Component
  CALLS_API = 'CALLS_API',    // TS Function → Go Function (cross-language)
  EXTENDS = 'EXTENDS',        // Class → Class (inheritance)
  USES_TYPE = 'USES_TYPE',    // Function/Component → Type (generic type argument usage)
  DOCUMENTED_BY = 'DOCUMENTED_BY', // Prose (Page/Section) → CodeSymbol (resolution deferred to a later slice)
  EVIDENCED_BY = 'EVIDENCED_BY', // Page → SessionEvent: kernel evidence-frontmatter provenance (citation-recon R2, #19)
}

export enum Language {
  Go = 'go',
  TypeScript = 'typescript',
  Tsx = 'tsx',
  Python = 'python',
  Rust = 'rust',
  Java = 'java',
  C = 'c',
  Cpp = 'cpp',
  Ruby = 'ruby',
  PHP = 'php',
  CSharp = 'csharp',
  Kotlin = 'kotlin',
  Swift = 'swift',
  JavaScript = 'javascript',
  Markdown = 'markdown',
  // Multi-format Source files (multiformat-distill-01). text-native + minimal binary.
  Html = 'html',
  Text = 'text',
  Yaml = 'yaml',
  Json = 'json',
  Pdf = 'pdf',
  Docx = 'docx',
  Pptx = 'pptx',
  Xlsx = 'xlsx',
}

// ─── Node ───────────────────────────────────────────────────────

export interface Node {
  id: string;
  type: NodeType;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  language: Language;
  package: string;
  exported: boolean;
  repo?: string;            // Multi-repo: which repo this node belongs to
  community?: string;       // Community detection: cluster label
  isTest?: boolean;          // Whether this node is from a test file

  // Go-specific (optional)
  receiver?: string;       // Method receiver type
  params?: string[];       // Function/method parameters
  returnType?: string;     // Return type
  fields?: string[];       // Struct fields
  embeds?: string[];       // Struct embedded types
  methodSignatures?: string[]; // Interface method signatures

  // TS-specific (optional)
  isDefault?: boolean;     // Default export
  props?: string[];        // Component props

  // Package-specific (optional)
  importPath?: string;     // Go import path
  files?: string[];        // Files in package/module
  imports?: string[];      // Direct import paths

  // Prose-specific (optional)
  syncedTo?: string;       // sync watermark: the source fingerprint a derived page was last reconciled against (sync-01)
  importance?: number;     // harvest-07: decay-weight importance prior (0–1) — `importance:` frontmatter (harvest-10) or a tier prior; read by harvest-09's scorer
  lastReinforced?: string; // harvest-07: recency timestamp from .wrxn/reinforce.json, joined by wiki-root-relative path (kernel reinforce-stamp, harvest-08)

  // Code-symbol-specific (optional)
  fingerprint?: string;    // sync-02: stable fingerprint of the symbol's tree-sitter AST (body/signature-sensitive, reformat/comment-insensitive)

  // SessionEvent-specific (optional) — citation-recon R1 (#18). Metadata lifted from
  // a .wrxn/events/*.jsonl record; the prompt body is kept OFF the node (searchText).
  eventKind?: string;      // the record's kind: 'prompt' | 'tool'
  ts?: string;             // the record's timestamp (carried verbatim as a string)
  tool?: string;           // tool record only: the tool name (e.g. 'Edit')
  target?: string;         // tool record only: the tool target (e.g. a file path)
}

// ─── Relationship ───────────────────────────────────────────────

export interface Relationship {
  id: string;
  type: RelationshipType;
  sourceId: string;
  targetId: string;
  confidence: number; // 0.0 - 1.0 (1.0 = compiler-verified)
  metadata?: {
    httpMethod?: string;   // For CALLS_API
    urlPattern?: string;   // For CALLS_API
    // citation-recon R2 (#19) — evidence-edge resolution, stamped at index time:
    tag?: 'resolved' | 'inferred'; // resolved = target node provably exists; inferred = heuristic/unverified link
    commit?: string;        // EVIDENCED_BY: the evidence.commit sha watermark (no commit node exists, so it rides here)
    commitResolved?: boolean; // EVIDENCED_BY: true iff `commit` is a syntactically valid sha (resolved); false = inferred
  };
}

// ─── Serialization ──────────────────────────────────────────────

export interface SerializedGraph {
  nodes: Node[];
  relationships: Relationship[];
}

/**
 * Tree-sitter Query Definitions
 *
 * S-expression queries for extracting definitions, calls, and imports
 * from Python, Rust, Java, C, and C++ source files.
 *
 * Capture conventions:
 *   @name                 — symbol name
 *   @definition.{type}    — definition node (function, class, struct, etc.)
 *   @call.name / @call    — function/method call
 *   @import.source / @import — import statement
 *   @heritage.class       — inheriting type name
 *   @heritage.extends     — parent type name
 *   @heritage.implements  — implemented interface/trait
 *   @heritage.trait        — trait being implemented (Rust)
 */

import { Language } from '../../graph/types.js';

// ─── Python ─────────────────────────────────────────────────────

export const PYTHON_QUERIES = `
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(import_statement
  name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (relative_import) @import.source) @import

(call
  function: (identifier) @call.name) @call

(call
  function: (attribute
    attribute: (identifier) @call.name)) @call

(class_definition
  name: (identifier) @heritage.class
  superclasses: (argument_list
    (identifier) @heritage.extends)) @heritage

(assignment
  left: (identifier) @name
  type: (type) @type_annotation) @definition.type

(decorated_definition
  (decorator (identifier) @decorator.name)
  definition: (function_definition name: (identifier) @decorated.func.name)) @decorator

(decorated_definition
  (decorator (attribute attribute: (identifier) @decorator.name))
  definition: (function_definition name: (identifier) @decorated.func.name)) @decorator

(decorated_definition
  (decorator (identifier) @decorator.name)
  definition: (class_definition name: (identifier) @decorated.class.name)) @decorator
`;

// ─── Rust ───────────────────────────────────────────────────────

export const RUST_QUERIES = `
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name !trait) @definition.impl
(impl_item type: (generic_type type: (type_identifier) @name) !trait) @definition.impl
(mod_item name: (identifier) @name) @definition.module
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.const
(static_item name: (identifier) @name) @definition.static
(macro_definition name: (identifier) @name) @definition.macro

(use_declaration argument: (_) @import.source) @import

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (scoped_identifier name: (identifier) @call.name)) @call

(struct_expression name: (type_identifier) @call.name) @call

(impl_item trait: (type_identifier) @heritage.trait type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (type_identifier) @heritage.trait type: (generic_type type: (type_identifier) @heritage.class)) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (generic_type type: (type_identifier) @heritage.class)) @heritage

(enum_item
  body: (enum_variant_list
    (enum_variant name: (identifier) @name))) @definition.const

(attribute_item
  (attribute
    (identifier) @attr.name)) @attribute
`;

// ─── Java ───────────────────────────────────────────────────────

export const JAVA_QUERIES = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum

(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor

(import_declaration (_) @import.source) @import

(method_invocation name: (identifier) @call.name) @call
(method_invocation object: (_) name: (identifier) @call.name) @call
(object_creation_expression type: (type_identifier) @call.name) @call

(class_declaration name: (identifier) @heritage.class
  (superclass (type_identifier) @heritage.extends)) @heritage

(class_declaration name: (identifier) @heritage.class
  (super_interfaces (type_list (type_identifier) @heritage.implements))) @heritage.impl

(enum_body
  (enum_constant name: (identifier) @name)) @definition.const

(marker_annotation name: (identifier) @annotation.name) @annotation
(annotation name: (identifier) @annotation.name) @annotation

(constant_declaration
  declarator: (variable_declarator name: (identifier) @name)) @definition.const
`;

// ─── C ──────────────────────────────────────────────────────────

export const C_QUERIES = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function

(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

(struct_specifier name: (type_identifier) @name) @definition.struct
(union_specifier name: (type_identifier) @name) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.typedef

(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

(preproc_include path: (_) @import.source) @import

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call

(enum_specifier
  body: (enumerator_list
    (enumerator name: (identifier) @name))) @definition.const
`;

// ─── C++ ────────────────────────────────────────────────────────

export const CPP_QUERIES = `
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(enum_specifier name: (type_identifier) @name) @definition.enum

(type_definition declarator: (type_identifier) @name) @definition.typedef
(union_specifier name: (type_identifier) @name) @definition.union

(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @definition.method
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function

(preproc_include path: (_) @import.source) @import

(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (qualified_identifier name: (identifier) @call.name)) @call

(new_expression type: (type_identifier) @call.name) @call

(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (type_identifier) @heritage.extends)) @heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (access_specifier) (type_identifier) @heritage.extends)) @heritage

(enum_specifier
  body: (enumerator_list
    (enumerator name: (identifier) @name))) @definition.const

(alias_declaration name: (type_identifier) @name) @definition.type
`;

// ─── Ruby ───────────────────────────────────────────────────────

export const RUBY_QUERIES = `
(class name: (constant) @name) @definition.class
(module name: (constant) @name) @definition.module
(method name: (identifier) @name) @definition.function
(singleton_method name: (identifier) @name) @definition.function

(call method: (identifier) @import.source) @import

(call method: (identifier) @call.name) @call

(class name: (constant) @heritage.class
  superclass: (superclass (constant) @heritage.extends)) @heritage

(assignment left: (constant) @name) @definition.const
`;

// ─── PHP ────────────────────────────────────────────────────────

export const PHP_QUERIES = `
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait
(enum_declaration name: (name) @name) @definition.enum

(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method

(namespace_use_declaration (namespace_use_clause (qualified_name) @import.source)) @import

(function_call_expression function: (name) @call.name) @call
(function_call_expression function: (qualified_name) @call.name) @call
(member_call_expression name: (name) @call.name) @call
(scoped_call_expression name: (name) @call.name) @call
(object_creation_expression (qualified_name) @call.name) @call

(class_declaration name: (name) @heritage.class
  (base_clause (name) @heritage.extends)) @heritage

(class_declaration name: (name) @heritage.class
  (class_interface_clause (name) @heritage.implements)) @heritage.impl

(const_declaration (const_element (name) @name)) @definition.const

(attribute (name) @annotation.name) @annotation
`;

// ─── C# ─────────────────────────────────────────────────────────

export const CSHARP_QUERIES = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum

(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor

(using_directive (qualified_name) @import.source) @import
(using_directive (identifier) @import.source) @import

(invocation_expression function: (identifier) @call.name) @call
(invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call
(object_creation_expression type: (identifier) @call.name) @call

(class_declaration name: (identifier) @heritage.class
  (base_list (identifier) @heritage.extends)) @heritage

(enum_member_declaration name: (identifier) @name) @definition.const

(attribute (identifier) @annotation.name) @annotation
`;

// ─── Kotlin ─────────────────────────────────────────────────────

export const KOTLIN_QUERIES = `
(class_declaration (type_identifier) @name) @definition.class
(object_declaration (type_identifier) @name) @definition.class
(interface_declaration (type_identifier) @name) @definition.interface

(function_declaration (simple_identifier) @name) @definition.function

(import_header (identifier) @import.source) @import

(call_expression (simple_identifier) @call.name) @call
(call_expression (navigation_expression (simple_identifier) @call.name)) @call

(class_declaration (type_identifier) @heritage.class
  (delegation_specifier_list (delegation_specifier (user_type (type_identifier) @heritage.extends)))) @heritage

(enum_entry (simple_identifier) @name) @definition.const

(type_alias (type_identifier) @name) @definition.type

(annotation (user_type (type_identifier) @annotation.name)) @annotation
`;

// ─── Swift ──────────────────────────────────────────────────────

export const SWIFT_QUERIES = `
(class_declaration name: (type_identifier) @name) @definition.class
(protocol_declaration name: (type_identifier) @name) @definition.interface
(struct_declaration name: (type_identifier) @name) @definition.struct
(enum_declaration name: (type_identifier) @name) @definition.enum

(function_declaration name: (simple_identifier) @name) @definition.function

(import_declaration (identifier) @import.source) @import

(call_expression (simple_identifier) @call.name) @call
(call_expression (navigation_expression (simple_identifier) @call.name)) @call

(class_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier (type_identifier) @heritage.extends)) @heritage

(typealias_declaration (type_identifier) @name) @definition.type
`;

// ─── JavaScript (CommonJS) ──────────────────────────────────────
//
// Slice B1: symbols + CALLS only. require()->IMPORTS edges, File nodes,
// and module.exports export-edges are Slice B2 (a separate story) and are
// deliberately NOT captured here. A require('x') call flows through as a
// plain call_expression (i.e. a CALLS edge at most) — correct B1 behavior.
//
// Node names below were verified against the installed tree-sitter-javascript
// grammar (0.21.4) by parsing fixtures and inspecting the s-expression:
//   function_declaration / generator_function_declaration name: (identifier)
//   variable_declarator name: (identifier) value: (arrow_function|function_expression)
//   class_declaration name: (identifier)
//   class_heritage (identifier)         -- bare identifier, no extends_clause wrapper
//   class_body (method_definition name: (property_identifier))
//   call_expression function: (identifier | member_expression property: (property_identifier))
//
// Methods are scoped to class_body so object-literal method shorthand (which
// the grammar also represents as method_definition) is not captured as a Method.

export const JAVASCRIPT_QUERIES = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function

(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function
(variable_declarator name: (identifier) @name value: (function_expression)) @definition.function

(class_declaration name: (identifier) @name) @definition.class

(class_body (method_definition name: (property_identifier) @name)) @definition.method

(class_declaration name: (identifier) @heritage.class
  (class_heritage (identifier) @heritage.extends)) @heritage

(call_expression function: (identifier) @call.name) @call
(call_expression function: (member_expression property: (property_identifier) @call.name)) @call

; require('./x') → import source (Slice B2). The #eq? predicate (verified
; honored by node-tree-sitter@0.21) limits this to calls named "require" with a
; STATIC string-literal argument: dynamic require(var) and require(\`tpl\`) have no
; (string (string_fragment)) child, so they are not captured here.
(call_expression
  function: (identifier) @_req (#eq? @_req "require")
  arguments: (arguments (string (string_fragment) @import.source))) @import
`;

// ─── TypeScript / TSX ───────────────────────────────────────────
//
// Shared by both Language.TypeScript (.ts/.mts/.cts via the `typescript`
// grammar) and Language.Tsx (.tsx via the `tsx` grammar). Both grammars
// expose the same node names for these constructs; only the JSX-vs-`<T>`-cast
// disambiguation differs, which does not affect these queries.
//
// Node names verified against tree-sitter-typescript@0.21 by parsing fixtures:
//   function_declaration / generator_function_declaration name: (identifier)
//   variable_declarator name: (identifier) value: (arrow_function|function_expression)
//   class_declaration / abstract_class_declaration name: (type_identifier)  -- NOT identifier
//   class_body (method_definition name: (property_identifier))
//   class_heritage (extends_clause value: (identifier))
//   class_heritage (implements_clause (type_identifier))
//   interface_declaration / type_alias_declaration name: (type_identifier)
//   enum_declaration name: (identifier)                                     -- identifier, not type_identifier
//   import_statement source: (string (string_fragment))
//   call_expression function: (identifier | member_expression property: (property_identifier))
//
// Heritage is wrapped in class_declaration/abstract_class_declaration so each
// match also carries @heritage.class (the child name) — the extractor requires
// heritage.class alongside heritage.extends/implements in the same match.

export const TYPESCRIPT_QUERIES = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function

(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function
(variable_declarator name: (identifier) @name value: (function_expression)) @definition.function

(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class

(class_body (method_definition name: (property_identifier) @name)) @definition.method

(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum

(class_declaration name: (type_identifier) @heritage.class
  (class_heritage (extends_clause value: (identifier) @heritage.extends))) @heritage
(abstract_class_declaration name: (type_identifier) @heritage.class
  (class_heritage (extends_clause value: (identifier) @heritage.extends))) @heritage

(class_declaration name: (type_identifier) @heritage.class
  (class_heritage (implements_clause (type_identifier) @heritage.implements))) @heritage
(abstract_class_declaration name: (type_identifier) @heritage.class
  (class_heritage (implements_clause (type_identifier) @heritage.implements))) @heritage

(call_expression function: (identifier) @call.name) @call
(call_expression function: (member_expression property: (property_identifier) @call.name)) @call

(import_statement source: (string (string_fragment) @import.source)) @import
`;

// ─── Query Map ──────────────────────────────────────────────────

export const LANGUAGE_QUERIES: Partial<Record<Language, string>> = {
  [Language.Python]: PYTHON_QUERIES,
  [Language.Rust]: RUST_QUERIES,
  [Language.Java]: JAVA_QUERIES,
  [Language.C]: C_QUERIES,
  [Language.Cpp]: CPP_QUERIES,
  [Language.Ruby]: RUBY_QUERIES,
  [Language.PHP]: PHP_QUERIES,
  [Language.CSharp]: CSHARP_QUERIES,
  [Language.Kotlin]: KOTLIN_QUERIES,
  [Language.Swift]: SWIFT_QUERIES,
  [Language.JavaScript]: JAVASCRIPT_QUERIES,
  [Language.TypeScript]: TYPESCRIPT_QUERIES,
  [Language.Tsx]: TYPESCRIPT_QUERIES,
};

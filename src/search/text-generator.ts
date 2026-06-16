/**
 * Text Generator for Embeddings
 *
 * Converts graph nodes into structured text suitable for embedding.
 * Each node produces a document like:
 *
 *   Function: getUserById
 *   Package: internal/auth
 *   File: auth/users.go
 *   Exported: true
 *
 * This structured format helps embedding models distinguish between
 * symbol names, packages, and file locations.
 */

import type { Node } from '../graph/types.js';
import { NodeType } from '../graph/types.js';

/**
 * Node types eligible for embedding.
 * Skips Package and File nodes (structural, not meaningful for search).
 */
const EMBEDDABLE_TYPES = new Set<NodeType>([
  NodeType.Function,
  NodeType.Method,
  NodeType.Struct,
  NodeType.Interface,
  NodeType.Component,
  NodeType.Type,
  NodeType.Class,
  NodeType.Enum,
  NodeType.Trait,
  NodeType.Module,
  NodeType.Page,
  NodeType.Section,
  NodeType.Source,
]);

/** Prose node types: their meaning lives in natural-language body text, not a code signature. */
const PROSE_TYPES = new Set<NodeType>([NodeType.Page, NodeType.Section, NodeType.Source]);

/**
 * Check if a node should be embedded.
 */
export function isEmbeddable(node: Node): boolean {
  return EMBEDDABLE_TYPES.has(node.type);
}

/**
 * Generate text from a node for embedding.
 *
 * Code nodes get the structured signature format below. Prose nodes (Page/Section)
 * carry their meaning in natural-language body text that is kept OFF the graph node
 * (see analyzers/markdown.ts + ADR 0002), so the caller passes that body via
 * `proseText` — the persisted searchText snapshot (heading + body). Embedding the
 * prose body, not a synthetic signature, is what lets a conceptual query match a
 * page that shares no surface keywords with it.
 */
export function generateEmbeddingText(node: Node, proseText?: string): string {
  if (PROSE_TYPES.has(node.type)) {
    const body = proseText?.trim();
    return body ? `${node.name}\n${body}` : node.name;
  }

  const parts: string[] = [];

  // Type and name
  parts.push(`${node.type}: ${node.name}`);

  // Package/module
  if (node.package) {
    parts.push(`Package: ${node.package}`);
  }

  // File location
  if (node.file) {
    parts.push(`File: ${node.file}`);
  }

  // Language
  parts.push(`Language: ${node.language}`);

  // Exported status
  if (node.exported) {
    parts.push('Exported: true');
  }

  // Go-specific metadata
  if (node.receiver) {
    parts.push(`Receiver: ${node.receiver}`);
  }
  if (node.params && node.params.length > 0) {
    parts.push(`Params: ${node.params.join(', ')}`);
  }
  if (node.returnType) {
    parts.push(`Returns: ${node.returnType}`);
  }
  if (node.fields && node.fields.length > 0) {
    parts.push(`Fields: ${node.fields.join(', ')}`);
  }
  if (node.methodSignatures && node.methodSignatures.length > 0) {
    parts.push(`Methods: ${node.methodSignatures.join(', ')}`);
  }

  // TS-specific
  if (node.props && node.props.length > 0) {
    parts.push(`Props: ${node.props.join(', ')}`);
  }

  return parts.join('\n');
}

# Recon — Prose Analyzer Context

The prose analyzer ingests markdown into recon's code knowledge graph, so conceptual queries surface documentation and docs link to the code they describe. One unified graph — code and prose nodes side by side.

## Language

**Prose node**:
A graph node derived from markdown — a Page or a Section. Always carries `exported: false`.
_Avoid_: doc node, markdown node

**Page**:
The graph node for one whole markdown file. The anchor for doc↔code edges; not the retrieval unit.
_Avoid_: Document, Doc

**Section**:
The graph node for one heading and the body beneath it. The **primary retrieval unit** for prose; one Page `CONTAINS` many Sections.
_Avoid_: Chunk, Passage, Heading node

**DOCUMENTED_BY**:
An edge from a prose node to the code symbol it documents. Committed only from a high-precision source — a frontmatter `derived_from:` anchor or an explicit `file:line` citation.
_Avoid_: DOCUMENTS, DESCRIBES

**type-gate**:
The boundary predicate that excludes prose node-types from the code-only tools (dead-code, unused-exports, impact, and `map` language counts).
_Avoid_: prose filter

**Hybrid retrieval**:
Lexical (BM25) and semantic (embedding) result lists fused by Reciprocal Rank Fusion. "Semantic search" names only the embedding half, not the whole.
_Avoid_: semantic search (for the whole)

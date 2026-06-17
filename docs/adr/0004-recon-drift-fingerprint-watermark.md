# Drift is decided by fingerprint-vs-fingerprint over the indexed graph alone

> Status: accepted — wrxn sync phase (sync-01/02/03/08), 2026-06-16

A prose page can be *derived from* a code symbol (a `derived_from` anchor →
a `DOCUMENTED_BY` edge). Such a page goes STALE when its source symbol changes
in a way that matters. recon must decide that staleness, but it serves queries
from an in-memory graph and exposes `recon_drift` over the HTTP door (ADR 0003) —
so the check must NOT shell `git`, walk `recon_changes`, or read the filesystem.

**Decision.** Drift is `fingerprint-vs-fingerprint`, computed from the indexed
graph alone (`src/mcp/drift.ts`, `computeDrift`):

- **Watermark = AST fingerprint.** sync-02 fingerprints each code symbol by its
  tree-sitter subtree (`astFingerprint`) — a STRUCTURAL signature that is stable
  across runs/processes and INSENSITIVE to reformatting and comment edits, but
  moves on a real structural change. A derived page records the fingerprint it was
  last reconciled against as its `synced_to` watermark (sync-01).
- **The compare.** For each Page whose single `derived_from` anchor resolves to a
  symbol carrying a `fingerprint`, and which carries a `synced_to` watermark, the
  page is **stale iff `symbol.fingerprint !== page.syncedTo`**. The anchor was
  resolved to the SPECIFIC symbol node at index time (`doc-edges.resolveAnchor` →
  `pickSymbol`), so the compare targets that exact symbol — never a whole file or
  an enclosing class whose fingerprint would subsume its methods.
- **Pure graph traversal.** No `git`, no `recon_changes`, no filesystem read —
  only the already-indexed graph — so `recon_drift` is HTTP-door-safe (sync-03).
- **Honest buckets, never a silent drop.** A page with no watermark →
  `unwatermarked`; a multi-target anchor (one watermark can't compare to several
  fingerprints) → `multiAnchor` (deferred, sync-01); a whole-file/no-fingerprint
  target → `uncomparable` (sync-03 AC5). Only incidental `file:line` body
  citations (below `CITATION_CONFIDENCE`) are excluded — they carry no watermark.

**The structured door sidecar (sync-08).** Over the HTTP door, `recon_drift`
returns the agent-facing markdown PLUS the full `DriftReport` as a structured
`drift` sidecar (`driftStructured` → `res.json({ result, drift })`). The kernel
sync loop (sync-04) reads `parsed.drift.stale` / `parsed.drift.unwatermarked` off
that body — mirroring the find `hits` and explain `neighbors` sidecars. The
markdown is a projection of the SAME `computeDrift` call, so the stdio output
stays byte-identical.

**Consequences.** Drift detection needs no VCS and no I/O at query time; it is a
deterministic function of the indexed graph, so it composes with the warm serve
door. Because the watermark is a STRUCTURAL fingerprint, cosmetic edits
(reformat, comments) never raise false drift, while a genuine structural change to
the documented symbol does.

**Alternatives rejected.** **`git`/`recon_changes` diffs** — require VCS and a
filesystem read, breaking the door-safe pure-graph contract, and flag churn that
is not structural. **Content/byte hashing** of the symbol — fires on reformatting
and comment edits (false drift). **Whole-file or enclosing-class anchors** — a
coarse fingerprint subsumes unrelated subtrees, so an edit anywhere in the file
would mark every derived page stale; resolving the anchor to the exact symbol at
index time is what makes the compare precise.

/**
 * Prose decay signals (harvest-07 / D1) — importance + reinforce-recency ingest.
 *
 * The recon-side foundation for Phase-5 decay-weighted retrieval (harvest-09 /
 * recon ADR 0005). Two per-page signals are carried onto prose Page nodes at
 * index/serve time. This is PURE INGEST — nothing here ranks; the scorer
 * (harvest-09) reads `node.importance` + `node.lastReinforced` later.
 *
 *   1. importance — a 0–1 score. From `importance:` frontmatter (written by
 *      harvest-10's dream stamp) WHEN present + valid; else a TIER PRIOR (below).
 *      A Page is NEVER left without importance, so the scorer always has a value.
 *   2. last_reinforced — a recency timestamp from the coalesced
 *      `.wrxn/reinforce.json` sidecar (written by the kernel reinforce-stamp,
 *      harvest-08), joined to a page by its WIKI-ROOT-RELATIVE path.
 *
 * PINNED CROSS-REPO CONTRACT — the reinforce.json join key is the page's
 * wiki-root-relative path (e.g. `concepts/foo.md`), IDENTICAL on both sides:
 * harvest-08 (kernel) stamps that key; harvest-07 (here) reads it. A slug-vs-path
 * mismatch silently breaks recency, so `wikiRelativePath` is the SINGLE source of
 * the key. harvest-09 + ADR 0005 reference TIER_PRIORS from this module.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeType } from '../graph/types.js';
import type { Node } from '../graph/types.js';

/** The wiki lives at `<install-root>/.wrxn/wiki/<tier>/…` by kernel convention. */
const WIKI_ROOT_PREFIX = '.wrxn/wiki/';

/** The coalesced recency sidecar — `<install-root>/.wrxn/reinforce.json` (STATE). */
const REINFORCE_SIDECAR = join('.wrxn', 'reinforce.json');

/**
 * Per-tier importance priors — the default a Page gets when it carries no valid
 * `importance:` frontmatter (harvest-10 hasn't stamped it, or the value is bad).
 * A small fixed map over the 4 kernel wiki tiers, monotone with durability /
 * authority: rules (operating constraints) > decisions (ADRs) > concepts
 * (domain) > gotchas (situational). Values are deliberately conservative and
 * referenced by harvest-09's scorer + recon ADR 0005 — change them there too.
 */
export const TIER_PRIORS: Record<string, number> = {
  _rules: 0.9,
  decisions: 0.8,
  concepts: 0.7,
  gotchas: 0.5,
};

/**
 * Importance for prose outside the 4 wiki tiers (ordinary docs, README, and any
 * unknown wiki subdir, e.g. `sessions/`). A neutral midpoint — present so every
 * Page carries an importance the scorer can read.
 */
export const NEUTRAL_IMPORTANCE = 0.5;

/**
 * The page's wiki-root-relative path — the PINNED reinforce.json join key. A
 * project-relative path under `.wrxn/wiki/` → the part after that prefix
 * (`.wrxn/wiki/concepts/foo.md` → `concepts/foo.md`). Not under the wiki
 * (ordinary docs / README) → null. A leading `./` and `\` separators are
 * tolerated so the key is stable across callers/platforms.
 */
export function wikiRelativePath(projectRelPath: string): string | null {
  const norm = projectRelPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm.startsWith(WIKI_ROOT_PREFIX)) return null;
  const rel = norm.slice(WIKI_ROOT_PREFIX.length);
  return rel || null;
}

/**
 * The default importance for a page with no valid `importance:` — its tier prior
 * (the first wiki-root-relative path segment, when a known tier), else
 * NEUTRAL_IMPORTANCE. Never throws.
 */
export function tierPriorFor(projectRelPath: string): number {
  const rel = wikiRelativePath(projectRelPath);
  const tier = rel ? rel.split('/')[0] : null;
  if (tier && tier in TIER_PRIORS) return TIER_PRIORS[tier];
  return NEUTRAL_IMPORTANCE;
}

/**
 * Parse + validate an `importance:` scalar to a number in [0,1]. Anything else
 * (non-number, NaN, out of [0,1], empty/undefined) → undefined, so the caller
 * falls back to the tier prior. Never throws.
 */
export function clampImportance(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
  return n;
}

/**
 * The coalesced recency sidecar: wiki-root-relative path → day-granular
 * `last_reinforced` timestamp. Read fail-open from `<root>/.wrxn/reinforce.json`
 * — an absent file, malformed JSON, or a non-object payload → {} (no recency;
 * serve unaffected). Only string-valued entries are kept. Never throws.
 */
export function loadReinforceSidecar(root: string): Record<string, string> {
  try {
    const raw = readFileSync(join(root, REINFORCE_SIDECAR), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Carry `last_reinforced` from the recency sidecar onto each prose Page node,
 * joined by the page's wiki-root-relative path. A non-Page node, a page outside
 * the wiki, or a page with no sidecar entry is left untouched (no recency).
 * Mutates the given nodes in place; an empty sidecar is a no-op.
 */
export function applyRecency(nodes: Node[], sidecar: Record<string, string>): void {
  if (Object.keys(sidecar).length === 0) return;
  for (const node of nodes) {
    if (node.type !== NodeType.Page) continue;
    const key = wikiRelativePath(node.file);
    if (!key) continue;
    const ts = sidecar[key];
    if (ts) node.lastReinforced = ts;
  }
}

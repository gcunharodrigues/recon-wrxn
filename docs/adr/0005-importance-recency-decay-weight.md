# Decay-weight Recall by importance × access-tracked recency, behind a mandatory gate

> Status: accepted — wrxn Phase 5 (harvest), 2026-06-17 (harvest-09 / D3)

recon ranks the prose half of `recon_find` with hybrid BM25 ⊕ vector RRF fusion
(`executeFindHybrid` → `mergeWithRRF`). Relevance alone has no memory of TIME or
WORTH: a long-superseded page that is still lexically/semantically on-topic keeps
ranking next to a freshly-reinforced, load-bearing one. The Generative Agents
retrieval model (recency × importance × relevance) is the fix — but a naive
time-decay can quietly trade away good-query recall, so it must be MEASURED before
it ships, not assumed.

**Decision.** Multiply a `recency × importance` decay factor into the RRF score at
the ranking step (`src/analyzers/decay-scorer.ts`, applied post-merge in
`executeFindHybrid` via `applyDecayRanking`). The factor is centered on 1 so it is
a re-weighting, not a wholesale re-scale:

- **importance** = D1's per-page `importance` (harvest-07): the `importance:`
  frontmatter when present + valid, else a per-tier prior (`TIER_PRIORS`:
  _rules > decisions > concepts > gotchas). The term is `importance / NEUTRAL_IMPORTANCE`,
  so the neutral prior (0.5) maps to 1 — prose at the neutral prior competes evenly
  with no-signal code; a higher tier/importance floats above 1, lower sinks below.
- **recency** = `0.5 ^ (ageDays / halfLife)` over `last_reinforced`, where age is
  measured against an INJECTED clock (the scorer never reads `Date.now()` itself, so
  it is pure + deterministic under test). Fresh (age ≤ 0) → 1, one half-life → 0.5.
- a node with **neither** signal gets a NEUTRAL factor of exactly 1 — code symbols
  and signal-less prose are never disturbed (rank-preserving).

**Recency is access-tracked via the coalesced sidecar, not frontmatter or mtime.**
`last_reinforced` is read from `.wrxn/reinforce.json` (harvest-08 kernel stamp,
joined by the pinned wiki-root-relative path — harvest-07). This is deliberate:
file **mtime** measures the last WRITE, not the last USE — a page nobody reads but a
formatter rewrites looks "fresh", and a constantly-recalled page that is never
edited looks "stale" (exactly backwards for relevance). **Frontmatter** recency
would require a write to the page on every access — turning a read path into a write
path, churning git, and racing concurrent readers. The coalesced sidecar records
ACCESS/reinforcement out-of-band, so the read path stays read-only and recency
tracks genuine use.

**The decay ships behind a MANDATORY measurement gate.** `test/unit/decay-gate.ts`
measures, on a gold fixture, that FULL decay both (a) SINKS a known-stale page AND
(b) HOLDS gold-query hit@5 vs the un-weighted baseline (within a stated tolerance).
The half-life is justified by a recorded sweep (7/14/30/60/90 days), not guessed —
30 days is the cadence-aligned choice the sweep validates. The verdict + metrics are
written to a durable report (`docs/eval/0005-decay-weight-gate.md`), verified on
every test run. `SHIPPED_DECAY_MODE` records the verdict and is locked to it by the
gate test, so it cannot drift silently.

**Importance-only is the safe fallback.** If the gate fails EITHER condition, the
shipped mode is `fallback`: importance-only, with NO time term. Pages are still
re-weighted by worth (importance), but a fresh page is never preferred to a stale one
on time alone — the regime that can hurt recall is simply not shipped. The fallback
is automatic and recorded; it is never a silent degrade.

**Consequences.** A long-un-reinforced page sinks in Recall WITHOUT being removed
(no deletion, no frontmatter write — this is ranking only); a kept-fresh,
high-importance page holds or rises. The behavior change is confined to the prose
fulltext/hybrid path; exact/pattern/structural code retrieval and the BM25 fallback
are untouched. Because the gate currently passes on the gold fixture, `full` ships.
Real-corpus hit@5 is re-validated out-of-band when the prose corpus changes (the
find-bm25 convention); a regression there flips the mode to `fallback` via the gate,
loudly.

**Alternatives rejected.** File **mtime** for recency — measures writes, not use
(backwards for relevance, and reformatting forges freshness). **Frontmatter**
`last_reinforced` — makes reads write, churns git, races readers. Shipping time-decay
**unmeasured** — the failure mode this whole ADR exists to prevent; a naive decay can
silently cost good-query recall. A summed Generative-Agents score (`w₁·recency +
w₂·importance + w₃·relevance`) over normalized components — needs global score
normalization across BM25 + cosine + priors and re-tuning of the existing weighted
RRF; the multiplicative, neutral-at-1 factor composes with the current RRF score
without disturbing the P1.5-tuned arm weights.

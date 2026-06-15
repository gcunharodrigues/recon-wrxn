# Markdown parsed with the mdast core, not regex or full remark

> Status: accepted — PRD `recon-prose-analyzer-00`, 2026-06-15

recon is deliberately dependency-light, but a hand-rolled markdown regex silently mis-extracts (a `#` inside a fenced code block becomes a fake heading → a fake Section node → a polluted graph), so the prose analyzer parses markdown with the **mdast parser core** (`mdast-util-from-markdown` + the frontmatter extension) — spec-compliant and pure-JS — rather than regex. We take the parser core, not the full `remark`/`unified` processor, to add the smallest correct dependency: the analyzer only needs headings, frontmatter, and inline link/citation extraction. "Good reason to add a dependency" is met because the analyzer's correctness depends on a real parser.

## Considered Options
- **Regex extraction** — rejected: fragile against CommonMark edge cases (code fences, setext headings, frontmatter), produces false nodes.
- **Full remark processor** — rejected: heavier than needed; we don't use the plugin/stringify pipeline.

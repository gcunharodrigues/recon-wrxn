/**
 * MCP Server Instructions
 *
 * Compact instructions injected into the AI agent's system prompt
 * when connecting to the recon-wrxn MCP server. Guides agents on WHEN
 * and HOW to use recon-wrxn tools vs built-in tools.
 */

export const RECON_INSTRUCTIONS = `recon-wrxn — code intelligence for YOUR codebase.

RULES:
1. Before modifying exported symbols → recon_impact first
2. New to a codebase → recon_map first
3. Before commit/PR → recon_changes first

USE recon-wrxn (not grep) when:
- "What calls this?" → recon_explain
- "What breaks?" → recon_impact
- "Find X" → recon_find
- "Code smells?" → recon_rules

USE BUILT-IN (not recon-wrxn) when:
- Read file contents → Read tool
- Search text literally → Grep tool`;

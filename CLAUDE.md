# google-tasks-mcp

MCP server for Google Tasks. Dual deployment: local stdio `.mcpb` extension for
Claude Desktop, and a Cloudflare Worker (`src/worker.ts`) served as a claude.ai
custom connector at `/mcp` with shared-bearer auth (header or `/mcp/<token>` path).
Design decisions and the v2 OAuth roadmap live in SPEC.md; setup in README.md.

Hard-won debugging lessons — read before touching auth, secrets, or the connector:

@LESSONS.md

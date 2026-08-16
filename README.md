# Google Tasks MCP

An MCP server that lets Claude manage your **Google Tasks** — the to-dos that show up on
Google Calendar. List, create (one or many at once), update, complete, move, and delete
tasks and task lists.

Sibling of [google-sheets-mcp](https://github.com/ezrazhang7/google-sheets-mcp); same
architecture, same deployment story:

- **Local** — a `.mcpb` desktop extension for Claude Desktop and local Cowork sessions.
- **Remote** — a Cloudflare Worker you add as a custom connector, which also works in
  **cloud Cowork sessions, claude.ai on the web, and mobile**.

Built on the [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk)
(2026-07-28 spec, with fallback for 2025-era clients such as today's claude.ai) and the
Google Tasks API v1, with no Google SDK dependency — just `fetch`, so the same code runs on
Node and in V8 isolates.

## The one thing to know about Google Tasks

Google Tasks stores **date-only** due dates. The API accepts a timestamp but discards the
time; there is no way to set or read a time of day. So every tool here takes `due` as
`YYYY-MM-DD` and the task renders as an **all-day** item on that date in Google Calendar.
(Sending local midnight instead of UTC midnight is the classic "task shows a day early"
bug — this server always sends UTC midnight.)

Other API limits: no recurring tasks, no starring, one level of subtasks, title ≤ 1024
chars, notes ≤ 8192 chars.

## Tools

| Tool | What it does |
|---|---|
| `list_tasklists` | All lists with ids and titles — call first |
| `create_tasklist` / `rename_tasklist` / `delete_tasklist` | Manage lists (delete requires `confirm: true`) |
| `list_tasks` | Tasks in a list; filter by `status` (open/completed/all), `dueAfter`, `dueBefore`, `updatedAfter` |
| `get_task` | One task by id |
| `create_task` | One task: `title`, `notes`, `due` (YYYY-MM-DD), optional parent/position |
| `create_tasks` | **Up to 100 tasks in one call**, idempotent on title+due by default; returns a per-item report |
| `update_task` | Change title / notes / due / status; pass `null` to clear notes or due |
| `complete_task` / `reopen_task` | Toggle done |
| `move_task` | Reorder, nest/un-nest, or move to another list |
| `delete_task` | Delete one task |
| `clear_completed` | Hide completed tasks (like the UI's "Clear completed") |

Lists can be referenced by **id or title**; omit for the default list.

## 1. Google Cloud credentials (one-time, needed either way)

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project
   (reusing the one from google-sheets-mcp is fine).
2. Enable the **Google Tasks API**.
3. **APIs & Services → OAuth consent screen**: add the scope
   `https://www.googleapis.com/auth/tasks`, add yourself under **Test users**, then click
   **Publish app**. Personal-use apps (under 100 users) don't need Google's verification
   review — you click through an "unverified app" warning once. Publishing matters
   because while the app sits in **Testing**, Google revokes refresh tokens every 7 days.
4. **APIs & Services → Credentials → OAuth client ID → Desktop app** (or reuse the sheets
   one). Save the **Client ID** and **Client Secret**.

> The Tasks API is free; the project never needs a billing account.

## 2a. Local install (Claude Desktop / local Cowork sessions)

```bash
npm install
npm run pack        # builds and produces google-tasks.mcpb (~1.7 MB)
```

Double-click `google-tasks.mcpb`, or Claude Desktop → **Settings → Extensions → Install
Extension…**. Paste your Client ID and Secret. On first use a browser opens to authorize;
the refresh token is cached at `~/.config/google-tasks-mcp/token.json`.

> Local MCP servers do **not** run in cloud Cowork sessions or on claude.ai — for those,
> use the remote deployment below.

## 2b. Remote install (cloud Cowork sessions, web, mobile)

**Mint a refresh token** (this one must carry the tasks scope — a token minted for sheets
won't work):

```bash
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET=… \
npm run mint-token
```

**Pick a bearer token** (a fresh one, not the sheets one, so each connector can be revoked
independently):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Deploy to Cloudflare Workers:**

```bash
npx wrangler login
npx wrangler secret put MCP_BEARER_TOKEN
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npm run deploy
```

Verify with `curl https://google-tasks-mcp.<you>.workers.dev/health` → `ok`.

**Add it to Claude**: Settings → **Connectors** → **Add custom connector**.

- If the dialog has a **Request headers** section: URL
  `https://google-tasks-mcp.<you>.workers.dev/mcp`, header
  `authorization: Bearer <your MCP_BEARER_TOKEN>`.
- Otherwise put the token in the path:
  `https://google-tasks-mcp.<you>.workers.dev/mcp/<your MCP_BEARER_TOKEN>`.

**First smoke test in Claude:** `list_tasklists`, then `create_task` with a `due` date, then
open Google Calendar and confirm it landed on the right day.

### Security notes

- The endpoint is public; the bearer token is the only gate. Long random value, treat as a
  password. Auth **fails closed** (no token configured → every request 401), comparison is
  constant-time, and browser `Origin` headers other than claude.ai are rejected (403).
- `GOOGLE_REFRESH_TOKEN` grants full read/write on every task list in the account.
- Revoke everything: [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Configuration reference

| Env var / secret | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client (both modes) |
| `GOOGLE_REFRESH_TOKEN` | Pre-minted refresh token (required for remote) |
| `MCP_BEARER_TOKEN` | Shared secret required by the remote endpoint |
| `GTASKS_TOKEN_PATH` | Override the local token cache location |

Scope: `https://www.googleapis.com/auth/tasks`.

## Development

```bash
npm install
npm run build       # compile to dist/
npm run typecheck
npm run pack        # build + package the .mcpb bundle
npm run dev:worker  # run the Worker locally via wrangler
npm run deploy
```

```
src/
  index.ts          stdio entry point (local)
  worker.ts         Cloudflare Worker entry (remote) + bearer auth + origin check
  server.ts         server factory: registers all tool groups
  config.ts         credentials → token provider, shared by both entries
  google/
    auth.ts         fetch-based refresh-token provider
    client.ts       REST client for the Tasks API (14 endpoints)
    types.ts        minimal API types
  node/
    localOAuth.ts   Node-only desktop OAuth loopback flow
    mintToken.ts    CLI to print a refresh token for remote deploys
  tools/
    lists.ts        task-list tools
    tasks.ts        single-task CRUD, complete/reopen, move, clear
    bulk.ts         create_tasks (batch, idempotent)
    shared.ts       zod schemas + compact task view
  utils/
    dates.ts        YYYY-MM-DD ↔ RFC 3339 UTC-midnight
    result.ts       tool result/error helpers
```

## Roadmap

- **v2 auth**: replace the shared secret with spec-conformant OAuth 2.1 (RFC 9728 PRM,
  PKCE, CIMD/DCR) using `@cloudflare/workers-oauth-provider`, so each Claude user connects
  their own Google account. Not needed for a personal deployment.

## License

MIT

# google-tasks-mcp — architecture spec

Baseline: `ezrazhang7/google-sheets-mcp` v0.2.4 (MCP TS SDK v2, dual stdio `.mcpb` + Cloudflare Worker, fetch + WebCrypto, shared-secret bearer + pre-minted Google refresh token). Research pass done 2026-08-16 against modelcontextprotocol.io, claude.com/docs/connectors, developers.google.com/workspace/tasks, npm/PyPI registries. Everything below is either verified from those sources or flagged.

---

## 0. TL;DR decisions

| Decision | Choice | Why |
|---|---|---|
| Repo | **New repo `google-tasks-mcp`, cloned from sheets** — not a new tool group inside the sheets server | Separate connector = separate secret, least-privilege scope, independent revoke. ~600 lines carry over verbatim (auth, config, worker, index, node/*, utils/result). |
| Auth to Claude | **Keep the sheets model (v1):** shared bearer secret, header or `/mcp/<secret>` path | Still works; claude.ai's Request-headers field is still labelled beta; you're the only user. Proper OAuth 2.1 (spec-conformant) is a documented v2 path below, not a blocker. |
| Auth to Google | **Same `RefreshTokenProvider`**, new scope `https://www.googleapis.com/auth/tasks` | Same Google Cloud project + same OAuth client is fine; you must **re-mint** a refresh token because scopes are fixed at consent. Enable **Tasks API** on the project. |
| Protocol | **Streamable HTTP, stateless, SDK v2 `createMcpHandler`** exactly as sheets | Serves 2026-07-28 clients natively and 2025-era claude.ai (still `initialize`-based) via the SDK's legacy-stateless fallback. HTTP+SSE is deprecated; don't add it. |
| Google client | **Raw `fetch`, no `googleapis`** (14 endpoints total) | Same reason as sheets: runs in V8 isolates, tiny bundle. `googleapis` is in maintenance mode anyway. |
| Due dates | **Tool input is `YYYY-MM-DD`; server sends `T00:00:00.000Z`** | Tasks API discards the time part and cannot store time-of-day at all; sending local-midnight timestamps produces the classic "one day early/late on Calendar" bug. All-day is the only mode — which matches your ECON convention. |

---

## 1. What the research changed vs. the sheets build (Aug 2026 reality)

- **Spec is now 2026-07-28** (stateless core: no `initialize`, no `Mcp-Session-Id`, no GET stream, mandatory `server/discover`, new `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers). Sheets is already on `@modelcontextprotocol/server@^2.0.0`, which implements it. **claude.ai still speaks 2025-03-26 / 06-18 / 11-25** ("2026-07-28 rolling out soon"), so the SDK's dual-era handling is load-bearing. Nothing to change; just don't set `legacy: 'reject'`.
- **Auth spec:** OAuth 2.1 + RFC 9728 PRM + RFC 8414 + PKCE S256 + RFC 8707 `resource`. **DCR (RFC 7591) is deprecated in favour of CIMD** (Client ID Metadata Documents). claude.ai supports `oauth_dcr`, `oauth_cimd`, `oauth_anthropic_creds`, `static_headers` (beta), `none`, and — new since the sheets build — **a pre-registered OAuth Client ID/Secret field in Advanced settings**. Redirect URI for hosted Claude surfaces is `https://claude.ai/api/mcp/auth_callback`.
- **Anthropic connector requirements:** every tool must declare `readOnlyHint` / `destructiveHint`; 401 (not 200+isError) for auth failures; 300 s tool timeout; ~150k-char result cap; egress `160.79.104.0/21`, IPv4, no cross-host redirects.
- **SDK v2 packaging:** `@modelcontextprotocol/server` 2.0.0 (+ `/core`, `/node`, `/express`, `/hono`, `/fastify` adapters). The old in-SDK OAuth-AS proxy (`mcpAuthRouter`, `ProxyOAuthServerProvider`) is frozen in `server-legacy` — SDK guidance is "MCP server = resource server; use a dedicated AS". For a Google-upstream AS on Workers the maintained thing is `@cloudflare/workers-oauth-provider` 0.10.x (DCR + CIMD + PKCE + auto-PRM). Cloudflare's `McpAgent` is deprecated/frozen; `createMcpHandler` from `agents/mcp/server` or plain SDK v2 is the current path — sheets already does the latter.
- **Google Tasks API:** `https://tasks.googleapis.com/tasks/v1`, scopes `auth/tasks` (rw) / `auth/tasks.readonly`; 50k queries/day courtesy quota; must be enabled per project. Testing-status refresh tokens die in 7 days (same rule sheets already documents — your app is published, so fine). Limits: title 1024, notes 8192, `tasks.list` max 100/page, 20k visible tasks/list, 100k/user, one level of subtasks, 2k subtasks/parent. **No recurrence, no starred, no time-of-day, no push notifications via API.** `@default` works as a list id (only documented in a deprecated Android guide — treat as legacy-but-working; resolve the real id on first call instead of relying on it).

---

## 2. Repository layout (diff vs. sheets)

```
google-tasks-mcp/
  package.json           name/bin/description; deps identical (@modelcontextprotocol/server ^2, zod ^4)
  wrangler.toml          name = "google-tasks-mcp"; same secrets list
  manifest.json          .mcpb manifest — same user_config (client id/secret), new name/description
  .mcpbignore            unchanged (already anchored correctly per LESSONS.md)
  tsconfig.json          unchanged
  src/
    index.ts             UNCHANGED except log prefix
    worker.ts            UNCHANGED except realm string
    server.ts            new SERVER_NAME/INSTRUCTIONS; registers tasks tool groups
    config.ts            UNCHANGED (still imports DEFAULT_SCOPES from google/auth)
    google/
      auth.ts            UNCHANGED except DEFAULT_SCOPES = ["…/auth/tasks"]
      client.ts          REWRITE: TasksClient over 14 REST methods (below)
      types.ts           REWRITE: TaskList, Task, list envelopes
    node/
      localOAuth.ts      UNCHANGED (cache path env → GTASKS_TOKEN_PATH, dir ~/.config/google-tasks-mcp/)
      mintToken.ts       UNCHANGED
    tools/
      lists.ts           tasklist tools
      tasks.ts           task CRUD
      bulk.ts            create_tasks (batch) — the syllabus use case
      shared.ts          zod schemas: listRef, dueDate, taskStatus, resolveList()
    utils/
      result.ts          UNCHANGED except error hints (403 → scope/Tasks API not enabled; 404 → list/task id)
      dates.ts           NEW: YYYY-MM-DD ↔ RFC3339-at-UTC-midnight, validation
```

Delete: `utils/a1.ts`, `tools/{read,write,structure,format,advanced}.ts`, Sheets/Drive types.

**Optional refactor (later, not now):** the 6 unchanged files are ~700 lines of copy-paste across two repos. If a third Google connector shows up, extract `@ezrazhang7/mcp-google-core` (auth, config, worker shell, result helpers, localOAuth, mintToken) and have both repos depend on it.

---

## 3. Google layer

### 3.1 `google/auth.ts`

```ts
export const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/tasks"];
```
Everything else — `CachingTokenProvider`, `RefreshTokenProvider`, `ServiceAccountProvider`, `StaticTokenProvider` — carries over. Note: service accounts have **no Tasks of their own** and Tasks has no sharing model, so `ServiceAccountProvider` is useless here unless you do domain-wide delegation on a Workspace domain. Keep the code (zero cost) but drop it from the README, or delete it and simplify `config.ts`. Recommend delete → `providerFromCredentials` becomes refresh-token-only.

### 3.2 `google/types.ts`

```ts
export interface TaskList { kind:"tasks#taskList"; id:string; etag?:string; title:string; updated?:string; selfLink?:string }
export type TaskStatus = "needsAction" | "completed";
export interface Task {
  kind:"tasks#task"; id:string; etag?:string; title:string; updated?:string; selfLink?:string;
  parent?:string; position?:string; notes?:string; status:TaskStatus;
  due?:string; completed?:string; deleted?:boolean; hidden?:boolean;
  links?:{type:string;description:string;link:string}[];
  webViewLink?:string;
  assignmentInfo?:{ linkToTask?:string; surfaceType?:"GMAIL"|"DOCUMENT"|"SPACE"|"CONTEXT_TYPE_UNSPECIFIED"; driveResourceInfo?:{driveFileId:string;resourceKey?:string}; spaceInfo?:{space:string} };
}
export interface Page<T> { kind:string; etag?:string; nextPageToken?:string; items?:T[] }
```

### 3.3 `google/client.ts` — `TasksClient`

Same `request<T>()` core as sheets (bearer from `TokenProvider`, JSON in/out, `GoogleApiError(status, message)`). Base `https://tasks.googleapis.com/tasks/v1`.

| Method | HTTP |
|---|---|
| `listTaskLists(maxResults=100, pageToken?)` | `GET /users/@me/lists` |
| `getTaskList(id)` / `insertTaskList({title})` / `patchTaskList(id,{title})` / `deleteTaskList(id)` | `GET/POST/PATCH/DELETE /users/@me/lists/{id}` |
| `listTasks(listId, {showCompleted, showHidden, showDeleted, showAssigned, dueMin, dueMax, completedMin, completedMax, updatedMin, maxResults≤100, pageToken})` | `GET /lists/{listId}/tasks` |
| `getTask(listId, taskId)` | `GET /lists/{listId}/tasks/{taskId}` |
| `insertTask(listId, body, {parent?, previous?})` | `POST /lists/{listId}/tasks?parent=&previous=` |
| `patchTask(listId, taskId, partial)` | `PATCH …/tasks/{taskId}` |
| `deleteTask(listId, taskId)` | `DELETE …/tasks/{taskId}` |
| `moveTask(listId, taskId, {parent?, previous?, destinationTasklist?})` | `POST …/tasks/{taskId}/move` |
| `clearCompleted(listId)` | `POST /lists/{listId}/clear` |
| `listAllTasks(listId, params)` | helper: follows `nextPageToken` (cap ~2k, log truncation) |
| `resolveList(ref)` | `"@default"` → id via `listTaskLists()[0]`? **No** — `@default` is not guaranteed first. Strategy: if `ref` looks like an id (matches `^[A-Za-z0-9_-]{10,}$`) try `getTaskList`; else case-insensitive title match over `listTaskLists()`; if `ref` omitted → `"@default"` passed straight through (Google resolves it). Cache per-request only (stateless server). |

Use PATCH not PUT for updates (PUT requires the full resource and clobbers fields).

---

## 4. Tool surface

Design rule from sheets: one tool per user intent, verbose descriptions, IDs-or-names accepted, all mutations idempotent where the API allows. Every tool sets `annotations` per Anthropic's requirement.

| Tool | Args | Annotations | Notes |
|---|---|---|---|
| `list_tasklists` | — | readOnly | Returns `[{id,title,updated}]`; instruct model to call this first. |
| `create_tasklist` | `title` | — | |
| `rename_tasklist` | `list`, `title` | — | |
| `delete_tasklist` | `list`, `confirm:true` | destructive | Deletes all tasks in it. Require `confirm`. |
| `list_tasks` | `list?` (default "@default"), `status?: "open"\|"completed"\|"all"` (default open), `dueAfter?`, `dueBefore?` (YYYY-MM-DD), `updatedAfter?`, `includeHidden?`, `limit?≤200` | readOnly | Map `status` → `showCompleted`; **completed tasks from the Google UI are usually `hidden`, so `status:"completed"` sets `showHidden:true` too** or users see nothing. Return `{id,title,notes,due(YYYY-MM-DD),status,completed,parent,webViewLink}` — strip `kind/etag/selfLink/position` to save tokens. |
| `get_task` | `list`, `taskId` | readOnly | |
| `create_task` | `list?`, `title`, `notes?`, `due?` (YYYY-MM-DD), `parentTaskId?`, `afterTaskId?` | — | `due` → `dates.toRfc3339UtcMidnight()`. Reject anything with a time component with a clear message ("Google Tasks stores dates only; give YYYY-MM-DD"). |
| `create_tasks` | `list?`, `tasks: [{title, notes?, due?, parentTaskId?}]` (1–100) | — | **The syllabus tool.** Sequential inserts with concurrency 4 (no batch endpoint worth relying on; per-user QPS is undocumented). Return per-item `{index, ok, id\|error}` — partial success is normal and must be visible. Idempotency guard: optional `skipIfExists:true` does a `list_tasks` first and skips exact `title+due` matches, so a retried call doesn't double-post 21 readings. |
| `update_task` | `list`, `taskId`, `title?`, `notes?`, `due?\|null`, `status?` | — | PATCH. `due:null` clears the date (Google: send `"due": null`? — **verify**; if PATCH won't null it, fall back to PUT with the field omitted). |
| `complete_task` / `reopen_task` | `list`, `taskId` | — | Sugar over `update_task status`. Reopen also needs `completed: null`. |
| `move_task` | `list`, `taskId`, `parentTaskId?`, `afterTaskId?`, `toList?` | — | `move` endpoint; note recurring tasks can't cross lists. |
| `delete_task` | `list`, `taskId` | destructive | |
| `clear_completed` | `list` | destructive | Hides completed; not reversible via API. |

Server `INSTRUCTIONS` (system-prompt-ish, like sheets):
> Google Tasks stores **date-only** due dates (they render as all-day on Google Calendar). Pass `due` as `YYYY-MM-DD`. Call `list_tasklists` once to learn list ids/titles, then `list_tasks` before creating to avoid duplicates. Use `create_tasks` for more than ~3 items. Task `title` is what shows on the calendar; put details in `notes`.

### 4.1 Your ECON convention → tool mapping (for the Math 381 job)

Title = `<CLASS>: <reading sections>` (whatever your ECON titles literally look like — I still haven't seen one; **inference**), `notes` = subject/topic + extra, `due` = the class date, all-day. So one `create_tasks` call with 21 items:

```json
{ "list": "<your school list>", "tasks": [
  { "title": "MATH 381: 1.1.1 – 1.1.4", "notes": "1.1 Propositional Logic", "due": "2026-08-17" },
  { "title": "MATH 381: 1.3.1 – 1.3.3", "notes": "1.3 Propositional Equivalences", "due": "2026-08-19" },
  …
]}
```

---

## 5. Worker / entry points

`worker.ts` is unchanged in shape: `/health` → `ok`; `/mcp` or `/mcp/<secret>`; fail-closed constant-time bearer check; `providerFromCredentials(env)` → `new TasksClient(tokens)` → `createMcpHandler(() => createServer(client)).fetch(request)`.

Two small upgrades worth making now, both spec-aligned and cheap:

1. **401 body/headers per current spec:** `WWW-Authenticate: Bearer realm="google-tasks-mcp", error="invalid_token"`. (No PRM yet — that's v2.) Anthropic explicitly says the 401 status is what triggers their auth UI; a 200 with `isError` does not.
2. **Origin check** on `/mcp` (spec: servers MUST validate `Origin`; 403 if present and not allowlisted). Allow absent Origin (server-to-server from claude.ai) and `https://claude.ai`.

`index.ts` (stdio) unchanged: lazy provider, `serveStdio`.

---

## 6. Setup runbook (delta from sheets README)

1. Google Cloud Console → same project → **Enable Google Tasks API**.
2. OAuth consent screen: add scope `…/auth/tasks` (Sensitive; no verification needed while <100 users; app already published so no 7-day expiry).
3. Reuse the existing Desktop OAuth client id/secret.
4. `GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… npm run mint-token` → **new** refresh token (tasks scope). The sheets token does not carry it.
5. New `MCP_BEARER_TOKEN` (don't reuse the sheets one — independent revoke).
6. `wrangler secret put` ×4, `npm run deploy` → `https://google-tasks-mcp.<you>.workers.dev`.
7. claude.ai → Settings → Connectors → Add custom connector → URL `…/mcp/<secret>` (or `/mcp` + `authorization` request header if the beta field is present).
8. Smoke test: `curl …/health`; then in Claude: `list_tasklists` → `create_task` with a due date → check it lands on the right day in Calendar (this catches the timezone-midnight bug immediately).

---

## 7. v2: spec-conformant OAuth (when/if you want it)

Trigger to do this: you want other people to use it, or Anthropic drops path-secret tolerance, or you want per-user Google accounts. Path:

- Add `@cloudflare/workers-oauth-provider` in front of the Worker: `apiRoute:"/mcp"`, `authorizeEndpoint:"/authorize"`, `tokenEndpoint:"/token"`, `clientRegistrationEndpoint:"/register"`, `clientIdMetadataDocumentEnabled:true` (+ `global_fetch_strictly_public` compat flag). Its `defaultHandler` runs the Google consent (redirect `https://google-tasks-mcp.<you>.workers.dev/callback`, registered on a **Web** OAuth client, not Desktop) and calls `completeAuthorization()` with the Google refresh token in encrypted `props`.
- It auto-serves RFC 9728 PRM + RFC 8414 metadata with `code_challenge_methods_supported:["S256"]`; add `token_endpoint_auth_methods_supported:["none"]` so Claude picks CIMD over DCR.
- Whitelist redirect `https://claude.ai/api/mcp/auth_callback` (+ `http://localhost:*/callback` for Claude Code).
- Per-client consent screen (spec's confused-deputy rule for static upstream client ids) — the provider gives you a hook.
- The MCP handler then reads `ctx.http.authInfo` → user's Google refresh token → `RefreshTokenProvider` per request. Delete `MCP_BEARER_TOKEN` and `GOOGLE_REFRESH_TOKEN` secrets. Needs a KV namespace for token/client storage (free tier ok).
- Alternative if you'd rather not run an AS at all: keep bearer, but move it to the `static_headers` mechanism only, once that field is GA.

---

## 8. Open items / flagged unknowns

- Whether PATCH with `"due": null` clears the date, or if you must PUT — test in step 8 of the runbook.
- Per-user/per-minute Tasks quota is undocumented; concurrency 4 is a guess — back off on 429 (already handled by `errorResult` hint; add one retry with jitter in `create_tasks`).
- claude.ai's switch-over date to 2026-07-28 wire format — SDK handles both, but re-run the smoke test when it lands.
- Your ECON task title format — I have inferred `CLASS: sections`; correct me and it's a one-line change in the tool description/instructions, not the code.

## Sources

MCP spec: https://modelcontextprotocol.io/specification/versioning · https://modelcontextprotocol.io/specification/2026-07-28/changelog · https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http · https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization · https://blog.modelcontextprotocol.io/posts/2026-07-28/
Claude connectors: https://claude.com/docs/connectors/building/index.md · https://claude.com/docs/connectors/building/authentication.md · https://claude.com/docs/connectors/building/lazy-authentication.md · https://claude.com/docs/connectors/building/mcp.md · https://claude.com/docs/connectors/custom/remote-mcp.md · https://claude.com/blog/bringing-mcp-2026-07-28-to-claude · https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
SDKs / hosting: https://github.com/modelcontextprotocol/typescript-sdk · https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html · https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html · https://github.com/cloudflare/workers-oauth-provider · https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/ · https://github.com/vercel/mcp-handler · https://gofastmcp.com/servers/auth/oauth-proxy
Google Tasks: https://developers.google.com/workspace/tasks/reference/rest · https://developers.google.com/workspace/tasks/reference/rest/v1/tasks · https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list · https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/move · https://developers.google.com/workspace/tasks/auth · https://developers.google.com/workspace/tasks/limits · https://developers.google.com/identity/protocols/oauth2#expiration · https://support.google.com/cloud/answer/15549945
Baseline: https://github.com/ezrazhang7/google-sheets-mcp

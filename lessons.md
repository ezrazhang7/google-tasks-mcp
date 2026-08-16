# Lessons

## 2026-08-16 — Debugging the claude.ai custom connector ("refuses to connect")

Deployed the Worker to Cloudflare and claude.ai's Add-custom-connector flow kept
failing, even though `/health` returned `ok`. The server was never broken; every
failure was a secrets-and-configuration mix-up on the client side. Root causes,
in the order we found them:

### 1. Three secrets, three different jobs — don't cross the streams

This build has three unrelated credentials, and each failure came from using one
where another belonged:

| Secret | Job | Where it lives |
|---|---|---|
| `MCP_BEARER_TOKEN` | Authenticates **Claude → Worker** | Wrangler secret + the connector URL path |
| `GOOGLE_REFRESH_TOKEN` | Authenticates **Worker → Google** | Wrangler secret only |
| `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` | Lets the Worker mint Google access tokens | Wrangler secret only |

- **First failure:** the Google *refresh token* (`1//01hTQ-…`) was pasted into the
  connector URL as if it were the bearer token. It can never match the bearer
  check, and it contains a `/`, so `/mcp/1/01hTQ-…` is two path segments and the
  route regex (`/^\/mcp(?:\/([^/]+))?$/`) 404s it before auth even runs.
- **Final failure:** the Google *client ID/secret* were entered into claude.ai's
  connector **Advanced → OAuth** fields. That tells claude.ai "this server is
  OAuth-protected": it ignored the already-working bearer connection, probed
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
  then tried `GET /authorize?...` on the Worker — a route that doesn't exist →
  404 → "failed to connect". For the bearer-token design, every claude.ai auth
  field must be left blank; the Google credentials never leave Wrangler secrets.

### 2. `wrangler tail` was the tool that actually solved it

Local repro (`wrangler dev` + curl) and a curl against the deployed URL both
returned perfect `initialize` responses, which proved the server and token were
fine but couldn't explain the claude.ai failure. Running `npx wrangler tail`
while clicking "Add connector" showed claude.ai's real request sequence —
including the surprise OAuth discovery probes and the `/authorize` attempt with
our own Google client ID in the query string, which pinpointed the misfilled
form field in one shot. Lesson: when a hosted client refuses to connect to a
Worker, tail the Worker and watch what the client actually sends; don't reason
from the client's generic error message.

### 3. Smaller findings worth keeping

- The Worker fails closed (`isAuthorized` returns false when `MCP_BEARER_TOKEN`
  is unset), so a missing secret looks identical to a wrong token: 401 on
  everything. Set it before deploying and prefer a non-interactive
  `printf '%s' "$TOKEN" | wrangler secret put MCP_BEARER_TOKEN` to rule out
  paste mangling in the masked prompt.
- Generate the bearer token in an alphabet with no `/` (base64url or hex) since
  it rides in a URL path segment.
- A browser GET of `/mcp/<token>` returns 405 "Method not allowed." — that is
  correct stateless streamable-HTTP behavior, not a failure. Only a POST
  `initialize` (with `Accept: application/json, text/event-stream`) tests
  anything. The root path 404ing with "The MCP endpoint is /mcp." is likewise
  by design.
- `wrangler secret put` on a not-yet-deployed Worker offers to create a
  placeholder Worker; the subsequent `npm run deploy` overwrites it with real
  code. Harmless, but the "There doesn't seem to be a Worker" prompt is
  expected on first setup, not an error.
- Debugging URLs and OAuth flows leak secrets into chats, screenshots, and
  browser history. After the connector worked: rotate the bearer token, reset
  the Google client secret, and re-mint the refresh token.

### Follow-up (spec'd, not built)

Proper OAuth 2.1 support (PRM metadata, `/authorize` + `/token`, PKCE, redirect
to `https://claude.ai/api/mcp/auth_callback`) is the v2 path in SPEC.md. It
would make claude.ai's OAuth fields legitimately usable and get the long token
out of the URL.

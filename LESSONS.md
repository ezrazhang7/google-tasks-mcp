# Lessons: claude.ai custom connector debugging (from the google-tasks-mcp build, Aug 2026)

Distilled from connecting the deployed Worker to claude.ai as a custom connector.
The server code worked on the first try; every failure was secrets-and-configuration
on the client side. Companion to the sheets repo's LESSONS.md, which covers the
build itself — this one covers the connect.

## Three secrets, three jobs — never cross the streams
This design has three unrelated credentials. Every connection failure in this build
was one of them used in another's place.

| Secret | Authenticates | Where it lives |
|---|---|---|
| `MCP_BEARER_TOKEN` | Claude → Worker | Wrangler secret + connector URL path (or header) |
| `GOOGLE_REFRESH_TOKEN` | Worker → Google | Wrangler secret ONLY |
| `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` | Worker → Google token mint | Wrangler secret ONLY |

- Only `MCP_BEARER_TOKEN` ever appears client-side. If a Google credential shows up
  in a connector URL or a claude.ai form field, something is wired wrong.
- Google refresh tokens start with `1//` — the slash splits a `/mcp/<token>` URL
  into two path segments and 404s on the route regex before auth even runs.
  Generate URL-path bearer tokens in hex or base64url (no `/` in the alphabet).
- If claude.ai's Advanced → OAuth Client ID/Secret fields are filled in, claude.ai
  treats the server as OAuth-protected **even when a plain bearer POST already
  succeeds**: it probes `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server`, then GETs `/authorize` on the server.
  A bearer-token server has none of those routes, so the connector fails despite
  being fully functional. Leave every claude.ai auth field blank.

## Diagnosis workflow that worked
1. `wrangler dev` + curl `initialize` locally — verifies the code.
2. curl the deployed URL — verifies the deployed secret.
3. `npx wrangler tail --format pretty` while re-adding the connector — shows the
   requests claude.ai *actually* sends. This exposed the `/authorize` call carrying
   our own Google client ID, pinpointing the misfilled form field in one shot.

Never reason from claude.ai's generic connection error; tail the server.

## Behavior that looks broken but isn't
- Browser GET of `/mcp/<token>` → 405 "Method not allowed." is correct stateless
  streamable-HTTP behavior. Root path 404 is by design. Only a POST `initialize`
  (with `Accept: application/json, text/event-stream`) tests anything.
- `wrangler secret put` on a not-yet-deployed Worker offers to create a placeholder
  Worker; the next real deploy overwrites it. Expected on first setup, not an error.

## Operational
- The Worker fails closed when `MCP_BEARER_TOKEN` is unset — 401 on everything,
  indistinguishable from a wrong token. Prefer
  `printf '%s' "$TOKEN" | wrangler secret put MCP_BEARER_TOKEN` over the interactive
  masked prompt (rules out paste mangling too).
- Debugging leaks secrets into chats, screenshots, and browser history. After the
  connector works: rotate the bearer token, reset the Google client secret, and
  re-mint the refresh token.

## v2 path
Proper OAuth 2.1 (PRM metadata, `/authorize` + `/token`, PKCE, redirect
`https://claude.ai/api/mcp/auth_callback`) is spec'd in SPEC.md. It's the fix that
makes claude.ai's OAuth fields legitimately usable and gets the token out of the URL.

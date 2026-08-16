import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import { TasksClient } from "./google/client.js";
import {
  MISSING_CREDENTIALS_MESSAGE,
  providerFromCredentials,
  type Credentials,
} from "./config.js";

/**
 * Worker bindings. Every value is a secret set with `wrangler secret put`,
 * never committed.
 */
export interface Env extends Credentials {
  /** Shared secret required in `Authorization: Bearer <token>` on every request. */
  MCP_BEARER_TOKEN?: string;
}

/**
 * Browser origins allowed to call /mcp. Server-to-server callers (claude.ai's
 * backend, Claude Code) send no Origin at all and are always allowed; the
 * spec only requires rejecting *unexpected* origins to block DNS rebinding.
 */
const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://claude.com"]);

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || ALLOWED_ORIGINS.has(origin);
}

/**
 * Constant-time string comparison, so a token can't be recovered by timing
 * how long a rejection takes.
 */
function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: "Invalid or missing bearer token." }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="google-tasks-mcp", error="invalid_token"',
      },
    },
  );
}

/**
 * Two ways to present the shared secret:
 *  1. `Authorization: Bearer <token>` header — preferred when the client UI
 *     can set request headers.
 *  2. `/mcp/<token>` in the URL path — fallback for connector UIs without a
 *     headers field (claude.ai's Request headers section is still a gated
 *     beta). Marginally weaker (URLs can land in logs), acceptable for a
 *     personal deployment.
 */
function isAuthorized(request: Request, env: Env, pathSecret?: string): boolean {
  const expected = env.MCP_BEARER_TOKEN;
  // Fail closed: with no token configured the endpoint would be world-writable.
  if (!expected) return false;
  if (pathSecret !== undefined && secureEquals(pathSecret, expected)) return true;
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] !== undefined && secureEquals(match[1], expected);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated liveness probe — deliberately reveals nothing.
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Accept /mcp (header auth) or /mcp/<secret> (path auth).
    const pathMatch = /^\/mcp(?:\/([^/]+))?$/.exec(url.pathname);
    if (!pathMatch) {
      return new Response("Not found. The MCP endpoint is /mcp.", { status: 404 });
    }
    if (!originAllowed(request)) {
      return new Response("Forbidden origin.", { status: 403 });
    }
    if (!isAuthorized(request, env, pathMatch[1])) {
      return unauthorized();
    }

    const tokens = providerFromCredentials(env);
    if (!tokens) {
      return new Response(
        JSON.stringify({ error: "server_misconfigured", error_description: MISSING_CREDENTIALS_MESSAGE }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const client = new TasksClient(tokens);
    const handler = createMcpHandler(() => createServer(client));
    return handler.fetch(request);
  },
};

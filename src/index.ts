#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";
import { TasksClient } from "./google/client.js";
import type { TokenProvider } from "./google/auth.js";
import { MISSING_CREDENTIALS_MESSAGE, providerFromCredentials } from "./config.js";
import { createLocalOAuthProvider } from "./node/localOAuth.js";

/**
 * Resolve credentials for a local (stdio) run, in order:
 *   1. A pre-minted refresh token in the environment
 *   2. OAuth client id/secret → interactive loopback flow, cached to disk
 */
async function resolveTokenProvider(): Promise<TokenProvider> {
  const env = process.env;

  const fromEnv = providerFromCredentials({
    GOOGLE_OAUTH_CLIENT_ID: env["GOOGLE_OAUTH_CLIENT_ID"],
    GOOGLE_OAUTH_CLIENT_SECRET: env["GOOGLE_OAUTH_CLIENT_SECRET"],
    GOOGLE_REFRESH_TOKEN: env["GOOGLE_REFRESH_TOKEN"],
  });
  if (fromEnv) return fromEnv;

  const clientId = env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (clientId && clientSecret) {
    return createLocalOAuthProvider(clientId, clientSecret);
  }
  throw new Error(MISSING_CREDENTIALS_MESSAGE);
}

/**
 * Credentials resolve lazily on first tool call: the loopback flow must not
 * block startup, and a missing-credentials error should surface as a readable
 * tool error rather than killing the process during initialize.
 */
let pending: Promise<TokenProvider> | undefined;
const lazyProvider: TokenProvider = {
  getAccessToken: () => {
    pending ??= resolveTokenProvider();
    return pending.then((provider) => provider.getAccessToken());
  },
};

serveStdio(() => createServer(new TasksClient(lazyProvider)), {
  onerror: (error) => console.error("[google-tasks-mcp]", error),
});

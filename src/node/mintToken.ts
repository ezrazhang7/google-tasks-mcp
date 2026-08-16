#!/usr/bin/env node
/**
 * One-off helper: run the Google OAuth consent flow locally and print a
 * refresh token for the remote deployment to use.
 *
 *   GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=… npm run mint-token
 *
 * The printed token is a long-lived credential granting access to your
 * tasks — store it with `wrangler secret put GOOGLE_REFRESH_TOKEN`
 * and keep it out of version control.
 */
import { runLoopbackFlow } from "./localOAuth.js";

const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];

if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET before running this.",
  );
  process.exit(1);
}

// Always run a fresh consent flow rather than reusing the cached token, so
// this prints a token even when a local install has already authorized.
const refreshToken = await runLoopbackFlow(clientId, clientSecret);

console.log("\n─────────────────────────────────────────────");
console.log("Your refresh token (treat it like a password):\n");
console.log(refreshToken);
console.log("\nStore it with:");
console.log("  npx wrangler secret put GOOGLE_REFRESH_TOKEN");
console.log("─────────────────────────────────────────────\n");

// Exit explicitly: a lingering browser socket must never leave this CLI
// hanging with the shell's stdin captured.
process.exit(0);

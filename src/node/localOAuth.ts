import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_SCOPES,
  RefreshTokenProvider,
  TOKEN_ENDPOINT,
  type TokenProvider,
} from "../google/auth.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** How long the interactive CLI (`mint-token`) waits for the browser. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a *tool call* waits before reporting that consent is pending.
 * MCP clients abandon a tool call around 60s, so blocking for the full
 * consent window just produces an opaque timeout. Instead we surface an
 * actionable message quickly and let the flow finish in the background —
 * the next tool call picks up the freshly cached token.
 */
const CONSENT_HINT_MS = 20_000;

const AUTH_PENDING_MESSAGE =
  "Google authorization needed. A browser window should have opened — approve " +
  'access there (if you see "Google hasn\'t verified this app", click Advanced → ' +
  "continue), then retry this request. If Google says the app is limited to " +
  "approved testers, either add your Google account under APIs & Services → " +
  "OAuth consent screen → Test users, or click Publish app on that screen to " +
  "lift the tester restriction.";

export function tokenCachePath(): string {
  return (
    process.env["GTASKS_TOKEN_PATH"] ??
    path.join(homedir(), ".config", "google-tasks-mcp", "token.json")
  );
}

async function readCachedToken(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(tokenCachePath(), "utf8")) as {
      refresh_token?: string;
    };
    return parsed.refresh_token || undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedToken(refreshToken: string): Promise<void> {
  const file = tokenCachePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ refresh_token: refreshToken }, null, 2), {
    mode: 0o600,
  });
}

/** Run the consent flow and persist the resulting token. */
async function mintAndCache(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const refreshToken = await runLoopbackFlow(clientId, clientSecret);
  await writeCachedToken(refreshToken);
  return refreshToken;
}

/** At most one consent flow runs at a time; later callers join the same one. */
let pendingConsent: Promise<string> | undefined;

/**
 * Start (or join) a consent flow, but give up waiting after CONSENT_HINT_MS
 * and report what the user needs to do. The flow itself keeps running, so
 * approving in the browser still caches the token for the next call.
 */
async function beginOrJoinConsent(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (!pendingConsent) {
    const flow = mintAndCache(clientId, clientSecret).finally(() => {
      pendingConsent = undefined;
    });
    // Nobody may be awaiting this once we stop racing it; swallow the
    // rejection here so it never surfaces as an unhandled promise rejection.
    // Real awaiters still observe it through their own reference.
    flow.catch(() => {});
    pendingConsent = flow;
  }

  let timer: NodeJS.Timeout | undefined;
  const hint = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(AUTH_PENDING_MESSAGE)), CONSENT_HINT_MS);
  });
  try {
    return await Promise.race([pendingConsent, hint]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a Google refresh token, running the desktop OAuth loopback flow only
 * if one is not already cached on disk. Node-only: this opens a browser and a
 * localhost listener, neither of which exists in a Worker.
 */
export async function getCachedRefreshToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  return (await readCachedToken()) ?? (await beginOrJoinConsent(clientId, clientSecret));
}

/**
 * `invalid_grant` means the stored refresh token no longer works — most often
 * because Google revoked it, which it does after 7 days for any OAuth app
 * still in "Testing" mode, but also after a password change or manual revoke.
 */
function isInvalidGrant(err: unknown): boolean {
  return err instanceof Error && err.message.includes("invalid_grant");
}

/**
 * A token provider for local runs that heals itself: when the cached refresh
 * token stops working it discards it, re-runs browser consent, and retries
 * once. Without this a Testing-mode app breaks every 7 days with an opaque
 * error and no way to recover short of deleting the cache by hand.
 */
export function createLocalOAuthProvider(
  clientId: string,
  clientSecret: string,
): TokenProvider {
  let delegate: RefreshTokenProvider | undefined;

  const build = async (forceConsent: boolean): Promise<RefreshTokenProvider> =>
    new RefreshTokenProvider(
      clientId,
      clientSecret,
      forceConsent
        ? await beginOrJoinConsent(clientId, clientSecret)
        : await getCachedRefreshToken(clientId, clientSecret),
    );

  return {
    async getAccessToken(): Promise<string> {
      delegate ??= await build(false);
      try {
        return await delegate.getAccessToken();
      } catch (err) {
        if (!isInvalidGrant(err)) throw err;
        console.error(
          "[google-tasks-mcp] Saved Google authorization is no longer valid " +
            "(Google revokes refresh tokens after 7 days while the OAuth app is " +
            'in "Testing" mode). Re-authorizing in your browser…',
        );
        delegate = await build(true);
        return delegate.getAccessToken();
      }
    },
  };
}

/**
 * Desktop OAuth loopback flow: listen on an ephemeral localhost port, open the
 * consent URL in a browser, and trade the returned code for a refresh token.
 */
export function runLoopbackFlow(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
      res.end(
        code
          ? "<h3>Google Tasks MCP is authorized.</h3>You can close this tab."
          : `<h3>Authorization failed.</h3>${error ?? "No code returned."}`,
      );
      // close() alone can leave the process alive: browsers hold speculative
      // keep-alive sockets that Node does not treat as idle. Drop them all so
      // the event loop can drain and a CLI caller can exit naturally.
      server.close();
      server.closeAllConnections();
      if (!code) {
        reject(new Error(`OAuth authorization failed: ${error ?? "no code"}`));
        return;
      }
      exchangeCode(code, redirectUri, clientId, clientSecret).then(resolve, reject);
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        scope: DEFAULT_SCOPES.join(" "),
      });
      const authUrl = `${AUTH_ENDPOINT}?${params}`;
      // stderr only: stdout carries the MCP protocol stream.
      console.error(`[google-tasks-mcp] Authorize in your browser:\n${authUrl}`);
      openBrowser(authUrl);
    });

    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth authorization timed out after 5 minutes."));
    }, FLOW_TIMEOUT_MS).unref();
  });
}

async function exchangeCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = JSON.parse(text) as { refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Revoke the app's access at " +
        "https://myaccount.google.com/permissions and authorize again.",
    );
  }
  return data.refresh_token;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => {
      // Browser could not be opened automatically; the URL is already on stderr.
    })
    .unref();
}

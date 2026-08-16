/**
 * Access-token providers built on `fetch` only, so the same code runs under
 * Node 20+ and inside Cloudflare Workers (V8 isolates).
 *
 * Google Tasks has no sharing model, so a service account has no tasks of its
 * own to act on — only the OAuth refresh-token path makes sense here.
 */

export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Scopes required by the tool set. */
export const DEFAULT_SCOPES = [
  // Create, edit, organize, and delete the user's task lists and tasks.
  "https://www.googleapis.com/auth/tasks",
];

/** Refresh a few seconds early so a token never expires mid-flight. */
const EXPIRY_SKEW_MS = 30_000;

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Shared expiry-aware caching around a token-minting function. */
abstract class CachingTokenProvider implements TokenProvider {
  #cached: CachedToken | undefined;
  #inFlight: Promise<CachedToken> | undefined;

  protected abstract mint(): Promise<CachedToken>;

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt - EXPIRY_SKEW_MS > now) {
      return this.#cached.token;
    }
    // Collapse concurrent refreshes into one request.
    this.#inFlight ??= this.mint().finally(() => {
      this.#inFlight = undefined;
    });
    this.#cached = await this.#inFlight;
    return this.#cached.token;
  }
}

async function requestToken(body: URLSearchParams): Promise<CachedToken> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token request failed (${res.status}): ${text}`);
  }
  const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Google token response contained no access_token.");
  }
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Exchanges a long-lived refresh token for access tokens. This acts as the
 * user who granted consent, so it reaches every task list they own.
 */
export class RefreshTokenProvider extends CachingTokenProvider {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
  ) {
    super();
  }

  protected override mint(): Promise<CachedToken> {
    return requestToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }),
    );
  }
}

/** A provider wrapping a pre-obtained access token (mainly for testing). */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

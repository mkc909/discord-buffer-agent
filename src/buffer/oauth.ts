/**
 * Buffer OAuth 2.0 — Authorization Code flow with PKCE (S256).
 *
 * Contest / product rail (Buffer Commit eligibility, 2026-11-13): the
 * app connects through Buffer OAuth, not only a personal API key. The
 * API-key rail (client.ts) stays as the fallback when no OAuth grant
 * exists or a token cannot be refreshed.
 *
 * Official flow (developers.buffer.com/guides/authentication.html):
 *   1. Register an App Client at publish.buffer.com → Settings → API.
 *      A confidential client gets a client_id + client_secret. Those
 *      values are Worker SECRETS here (BUFFER_OAUTH_CLIENT_ID /
 *      BUFFER_OAUTH_CLIENT_SECRET) — never source, git, chat, or logs.
 *   2. Authorize: GET https://auth.buffer.com/auth?client_id=…
 *      &redirect_uri=…&response_type=code&scope=…&state=…
 *      &code_challenge=…&code_challenge_method=S256&prompt=consent
 *   3. Callback returns ?code=&state= (or ?error=access_denied&state=).
 *   4. Token exchange: POST https://auth.buffer.com/token
 *      (application/x-www-form-urlencoded).
 *   5. API calls: Authorization: Bearer <access_token> against
 *      https://api.buffer.com — the same GraphQL client as the API-key
 *      rail; only the credential source differs.
 *
 * REFRESH TOKENS ARE SINGLE-USE AND ROTATE. Every successful refresh
 * returns a NEW refresh_token and spends the old one; reusing a spent
 * refresh token revokes the whole grant. Callers must persist the
 * rotated token set returned by refreshAccessTokens() before using
 * the new access token — see PublishingAgent.getOAuthAccessToken,
 * which is the only refresh call site.
 */

export const BUFFER_AUTH_URL = "https://auth.buffer.com/auth";
export const BUFFER_TOKEN_URL = "https://auth.buffer.com/token";

/** Scopes requested at authorize time — the minimum this app uses. */
export const BUFFER_OAUTH_SCOPES =
  "posts:read posts:write account:read offline_access";

/**
 * Name of the dedicated PublishingAgent instance that owns OAuth token
 * storage ("oauth"). Per-org instances are named `org:<organizationId>`;
 * the OAuth instance holds no publishing items, only token state (see
 * publishing-agent.ts and the /oauth/* routes in index.ts).
 */
export const OAUTH_AGENT_INSTANCE = "oauth";

/** Durable Object storage keys used by the OAuth agent instance. */
export const OAUTH_TOKENS_STORAGE_KEY = "oauth:tokens";
export const OAUTH_PENDING_STORAGE_KEY = "oauth:pending";

/** A pending authorize flow lives at most 10 minutes and is single-use. */
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

/** Environment contract for the OAuth flow (all values from secrets). */
export interface BufferOAuthEnv {
  BUFFER_OAUTH_CLIENT_ID?: string;
  BUFFER_OAUTH_CLIENT_SECRET?: string;
  BUFFER_OAUTH_REDIRECT_URI?: string;
}

export interface BufferOAuthConfig {
  clientId: string;
  /**
   * Null for a PUBLIC client (registered with "Public client (no client
   * secret)" — PKCE alone authenticates the token exchange, and the
   * client_secret parameter must NOT be sent). This deployment uses a
   * public client, chosen 2026-11-13 so no client secret ever has to
   * transit a chat, ticket, or vault lane to reach the Worker.
   */
  clientSecret: string | null;
  redirectUri: string;
}

/**
 * Resolve the OAuth client config from env, or null when OAuth is not
 * configured on this deployment (the API-key rail then serves alone).
 * A missing BUFFER_OAUTH_CLIENT_SECRET means a public client, not an
 * unconfigured one — only clientId and redirectUri are required.
 */
export function getOAuthConfig(
  env: BufferOAuthEnv,
): BufferOAuthConfig | null {
  const clientId = env.BUFFER_OAUTH_CLIENT_ID;
  const clientSecret = env.BUFFER_OAUTH_CLIENT_SECRET;
  const redirectUri = env.BUFFER_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) return null;
  return { clientId, clientSecret: clientSecret || null, redirectUri };
}

// ----------------------------------------------------------------
// Token set
// ----------------------------------------------------------------

export interface BufferTokenSet {
  accessToken: string;
  /**
   * Present only because we request `offline_access`. Single-use:
   * every refresh spends this value and returns its replacement.
   */
  refreshToken: string | null;
  tokenType: string;
  /** Space-separated scopes Buffer actually granted. */
  scope: string;
  /** Epoch ms when this set was obtained from the token endpoint. */
  obtainedAt: number;
  /** Epoch ms when accessToken expires (obtainedAt + expires_in). */
  expiresAt: number;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Build a token set from a token-endpoint JSON body, stamping expiry. */
export function tokenSetFromResponse(
  body: TokenEndpointResponse,
  now: number = Date.now(),
): BufferTokenSet {
  if (!body.access_token) {
    throw new BufferOAuthError(
      "Buffer token endpoint returned no access_token",
    );
  }
  const expiresInSeconds =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : 3600;
  return {
    accessToken: body.access_token,
    // Persist exactly what the server returned. On refresh, Buffer
    // rotates: the returned refresh_token replaces (and the spent one
    // must never be reused — reuse revokes the grant). If a refresh
    // response ever omitted it, we store null rather than keep a spent
    // token that would revoke the grant on next use.
    refreshToken: body.refresh_token ?? null,
    tokenType: body.token_type ?? "Bearer",
    scope: body.scope ?? BUFFER_OAUTH_SCOPES,
    obtainedAt: now,
    expiresAt: now + expiresInSeconds * 1000,
  };
}

/**
 * Is the access token expired (or inside the safety skew)? A refresh
 * should be attempted when this is true and a refreshToken exists.
 */
export function isAccessTokenExpired(
  tokens: BufferTokenSet,
  now: number = Date.now(),
  skewMs: number = 60_000,
): boolean {
  return now + skewMs >= tokens.expiresAt;
}

// ----------------------------------------------------------------
// PKCE + state (WebCrypto only — Workers have no node:crypto here)
// ----------------------------------------------------------------

/** base64url-encode bytes (no padding), per RFC 7636. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** code_verifier = base64url(32 random bytes) — 43 chars, RFC 7636 §4.1. */
export function generateCodeVerifier(): string {
  return randomBase64Url(32);
}

/** state = base64url(32 random bytes) — CSRF token for the flow. */
export function generateOAuthState(): string {
  return randomBase64Url(32);
}

/** code_challenge = base64url(SHA-256(ASCII(code_verifier))), S256. */
export async function computeCodeChallenge(
  codeVerifier: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

// ----------------------------------------------------------------
// Authorize URL
// ----------------------------------------------------------------

export function buildAuthorizeUrl(input: {
  config: BufferOAuthConfig;
  state: string;
  codeChallenge: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    response_type: "code",
    scope: input.scope ?? BUFFER_OAUTH_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${BUFFER_AUTH_URL}?${params.toString()}`;
}

// ----------------------------------------------------------------
// Token endpoint
// ----------------------------------------------------------------

export class BufferOAuthError extends Error {
  readonly status?: number;
  readonly oauthError?: string;
  constructor(message: string, status?: number, oauthError?: string) {
    super(message);
    this.name = "BufferOAuthError";
    this.status = status;
    this.oauthError = oauthError;
  }
}

async function postTokenRequest(
  form: URLSearchParams,
): Promise<BufferTokenSet> {
  const response = await fetch(BUFFER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await response.text();
  let body: TokenEndpointResponse = {};
  try {
    body = JSON.parse(text) as TokenEndpointResponse;
  } catch {
    // Non-JSON error body — fall through to the status-based error.
  }
  if (!response.ok || body.error) {
    // The message carries only the endpoint's error code/description —
    // never the request form (which holds the client secret / code /
    // verifier) and never any token value.
    throw new BufferOAuthError(
      `Buffer token request failed (${response.status}): ${
        body.error_description ?? body.error ?? "unknown error"
      }`,
      response.status,
      body.error,
    );
  }
  return tokenSetFromResponse(body);
}

/** Exchange an authorization code (+ PKCE verifier) for a token set. */
export async function exchangeCode(input: {
  config: BufferOAuthConfig;
  code: string;
  codeVerifier: string;
}): Promise<BufferTokenSet> {
  const form = new URLSearchParams({
    client_id: input.config.clientId,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.config.redirectUri,
    code_verifier: input.codeVerifier,
  });
  // Public clients authenticate with the verifier alone and must NOT
  // send a client_secret; confidential clients must send theirs.
  if (input.config.clientSecret) {
    form.set("client_secret", input.config.clientSecret);
  }
  return postTokenRequest(form);
}

/**
 * Refresh a token set. ROTATION: the refresh token is single-use —
 * the returned set carries its replacement and MUST be persisted,
 * discarding the old set, before anything retries with the old one.
 */
export async function refreshAccessTokens(input: {
  config: BufferOAuthConfig;
  refreshToken: string;
}): Promise<BufferTokenSet> {
  const form = new URLSearchParams({
    client_id: input.config.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (input.config.clientSecret) {
    form.set("client_secret", input.config.clientSecret);
  }
  return postTokenRequest(form);
}

// ----------------------------------------------------------------
// Pending flow (stored server-side in the OAuth agent instance)
// ----------------------------------------------------------------

export interface PendingOAuthFlow {
  state: string;
  codeVerifier: string;
  /** Epoch ms when /oauth/start created the flow. */
  createdAt: number;
}

export function isPendingFlowExpired(
  flow: PendingOAuthFlow,
  now: number = Date.now(),
): boolean {
  return now - flow.createdAt > OAUTH_PENDING_TTL_MS;
}

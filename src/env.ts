/**
 * Worker environment contract.
 *
 * Every secret below is supplied by the platform at runtime
 * (`wrangler secret put <NAME>` in production, `.dev.vars` locally).
 * No secret value ever appears in source, git, chat, or logs.
 */
export interface Env {
  /** Durable Object namespace for the per-org PublishingAgent. */
  PUBLISHING_AGENT: DurableObjectNamespace;

  /** Discord application ID (public identifier, set as a secret/var at deploy). */
  DISCORD_APPLICATION_ID: string;
  /** Discord application public key (hex) — verifies interaction signatures. */
  DISCORD_PUBLIC_KEY: string;
  /** Bot token — used only for REST follow-ups (threads, message edits). */
  DISCORD_BOT_TOKEN: string;

  /**
   * Buffer personal API key (Buffer Settings → API). PRIMARY credential:
   * the GraphQL rail sends it as Authorization: Bearer to
   * https://api.buffer.com — the same key authenticates both the API and
   * Buffer's hosted MCP (verified 2026-10-24). From env — never source.
   */
  BUFFER_API_KEY: string;
  /**
   * Buffer personal access token (posts:write scope) — alternate
   * credential name for the same GraphQL rail (the hub pattern).
   */
  BUFFER_ACCESS_TOKEN?: string;
  /**
   * Rail selector. Default (unset) = "graphql", the API-first production
   * rail. "mcp" opts into Buffer's hosted MCP server — dev/ad-hoc only,
   * never a product dependency (Mike, 2026-10-24).
   */
  BUFFER_RAIL?: string;
  /** Buffer organization that owns the ContentItems this deployment manages. */
  BUFFER_ORGANIZATION_ID: string;

  /**
   * Buffer OAuth client ID — from the App Client registered at
   * publish.buffer.com → Settings → API (see src/buffer/oauth.ts).
   * Optional: a deployment without the OAuth trio runs on the API-key
   * rail alone. When set, OAuth is the preferred credential and the
   * API key is the fallback.
   */
  BUFFER_OAUTH_CLIENT_ID?: string;
  /** Buffer OAuth client secret for the confidential App Client. */
  BUFFER_OAUTH_CLIENT_SECRET?: string;
  /**
   * OAuth redirect URI registered on the App Client — must be exactly
   * https://<worker-host>/oauth/callback for this deployment.
   */
  BUFFER_OAUTH_REDIRECT_URI?: string;

  /** Discord webhook used by the drift watcher to raise schema-change alerts. */
  DRIFT_ALERT_WEBHOOK_URL?: string;
}

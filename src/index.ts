/**
 * Discord Buffer Agent — Worker entry.
 *
 * Routes:
 *   POST /interactions   Discord interactions endpoint. The Ed25519
 *                        signature is verified BEFORE anything else —
 *                        unverified requests get 401 and no handling.
 *   /agents/...          Cloudflare Agents SDK routing (agent RPC /
 *                        websocket surface for future tooling).
 *   GET  /health         liveness only; carries no state and no secrets.
 *   GET  /oauth/start    Begin Buffer OAuth (Authorization Code + PKCE):
 *                        stores a single-use, 10-minute pending flow on
 *                        the "oauth" agent instance, then 302s to
 *                        Buffer's authorize URL.
 *   GET  /oauth/callback Buffer redirects here with ?code=&state= (or
 *                        ?error=…&state=). Verifies + consumes the
 *                        pending state, exchanges the code, stores the
 *                        token set on the "oauth" instance, and returns
 *                        a small success page — token values never
 *                        appear in any response.
 *   GET  /oauth/status   JSON {connected, expiresAt, scope} only.
 *
 * Cron: the drift watcher (src/drift/watcher.ts) runs on the schedule in
 * wrangler.toml and records its verdict on the default org agent.
 */
import { routeAgentRequest, getAgentByName } from "agents";
import type { Env } from "./env";
import type { PublishingAgent } from "./agent/publishing-agent";
import { verifyDiscordSignature } from "./discord/verify";
import {
  InteractionType,
  InteractionResponseType,
  type Interaction,
} from "./discord/types";
import { handleInteraction } from "./discord/handlers";
import { runDriftCheck } from "./drift/watcher";
import {
  OAUTH_AGENT_INSTANCE,
  buildAuthorizeUrl,
  computeCodeChallenge,
  exchangeCode,
  generateCodeVerifier,
  generateOAuthState,
  getOAuthConfig,
} from "./buffer/oauth";

export { PublishingAgent } from "./agent/publishing-agent";

/** The dedicated PublishingAgent instance that owns OAuth token state. */
async function getOAuthAgent(env: Env) {
  return getAgentByName(
    env.PUBLISHING_AGENT as unknown as DurableObjectNamespace<PublishingAgent>,
    OAUTH_AGENT_INSTANCE,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Small static HTML page for OAuth outcomes — never carries tokens. */
function oauthPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Discord Buffer Agent</title></head><body>
<h1>Discord Buffer Agent</h1>
<p>Run your Buffer publishing from inside Discord: slash commands and approval buttons on the front, a durable agent holding your publishing state behind them, and Buffer's ContentItem API at the core — with a watcher that tells you when that experimental API changes.</p>
<p>Built for <a href="https://buffer.com/api/commit">Buffer Commit</a> by Michael Courtney (Aura Media Studios).</p>
<ul>
<li><a href="/oauth/start">Connect your Buffer account (OAuth)</a> — status: <a href="/oauth/status">/oauth/status</a></li>
<li><a href="/privacy">Privacy policy</a></li>
</ul>
<p>Commands in Discord: <code>/draft</code> <code>/attach</code> <code>/queue</code> <code>/approve</code> <code>/status</code>. Nothing is scheduled or published without a human approval bound to the exact content.</p>
</body></html>`,
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    if (url.pathname === "/privacy" && request.method === "GET") {
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Privacy Policy — Discord Buffer Agent</title></head><body>
<h1>Privacy Policy — Discord Buffer Agent</h1>
<p>Last updated: November 13, 2026. Operator: Michael Courtney (Aura Media Studios), contact mike@michaelcourtney.com.</p>
<h2>What the app touches</h2>
<ul>
<li>Discord identifiers: the user and guild IDs attached to commands you run, and the IDs of messages and threads the app creates for your content items.</li>
<li>Buffer access: when you connect Buffer, OAuth tokens are stored server-side in the app's durable storage and used only to call the Buffer API on your behalf. The app requests posts read/write and account read scopes, plus offline access so the connection survives token expiry.</li>
<li>Content you submit: the text and settings of drafts you create through the app, and approval records (who approved what, and when).</li>
</ul>
<h2>What the app never does</h2>
<ul>
<li>It never sells or shares your data with third parties.</li>
<li>It never schedules or publishes anything without a human approval recorded in the app.</li>
<li>It never stores your Buffer or Discord password.</li>
</ul>
<h2>Retention and deletion</h2>
<p>Publishing state is kept while your workspace uses the app so threads, approvals, and items stay reconcilable. Ask the operator at the contact address to delete your workspace's data or disconnect your Buffer grant; disconnecting removes the stored tokens. You can also revoke the app's Buffer access at any time from your Buffer settings.</p>
</body></html>`,
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/oauth/start") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const config = getOAuthConfig(env);
      if (!config) {
        return oauthPage(
          "Buffer OAuth is not configured",
          "This deployment has no Buffer OAuth client configured (BUFFER_OAUTH_CLIENT_ID / BUFFER_OAUTH_REDIRECT_URI). The API-key rail still serves Buffer calls.",
          500,
        );
      }
      const state = generateOAuthState();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const stub = await getOAuthAgent(env);
      await stub.beginOAuthFlow({
        state,
        codeVerifier,
        createdAt: Date.now(),
      });
      return Response.redirect(
        buildAuthorizeUrl({ config, state, codeChallenge }),
        302,
      );
    }

    if (url.pathname === "/oauth/callback") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const config = getOAuthConfig(env);
      if (!config) {
        return oauthPage(
          "Buffer OAuth is not configured",
          "This deployment has no Buffer OAuth client configured, so the callback cannot be completed.",
          500,
        );
      }
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (!state) {
        return oauthPage(
          "Buffer connection failed",
          "The callback arrived without a state parameter, so it cannot be matched to a pending flow.",
          400,
        );
      }
      // Consume first: the pending flow is single-use whether Buffer
      // sent back a code or an error, and an unknown/expired state
      // ends the flow here either way.
      const stub = await getOAuthAgent(env);
      const pending = await stub.consumeOAuthPending(state);
      if (!pending) {
        return oauthPage(
          "Buffer connection failed",
          "This sign-in link is invalid or has expired (links live for 10 minutes and work once). Start again from /oauth/start.",
          400,
        );
      }
      if (error) {
        return oauthPage(
          "Buffer connection declined",
          `Buffer returned an error: ${escapeHtml(error)}. No connection was stored. Start again from /oauth/start whenever you are ready.`,
          400,
        );
      }
      if (!code) {
        return oauthPage(
          "Buffer connection failed",
          "The callback arrived without an authorization code. Start again from /oauth/start.",
          400,
        );
      }
      try {
        const tokens = await exchangeCode({
          config,
          code,
          codeVerifier: pending.codeVerifier,
        });
        await stub.saveOAuthTokens(tokens);
      } catch (err) {
        console.error(
          "buffer oauth: code exchange failed",
          err instanceof Error ? err.message : String(err),
        );
        return oauthPage(
          "Buffer connection failed",
          "Exchanging the authorization code with Buffer failed. No connection was stored. Start again from /oauth/start.",
          502,
        );
      }
      return oauthPage(
        "Buffer connected",
        "Your Buffer account is connected through OAuth. The Discord Buffer Agent will now use this connection for Buffer API calls (the API key remains configured as a fallback). You can close this page.",
        200,
      );
    }

    if (url.pathname === "/oauth/status") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const stub = await getOAuthAgent(env);
      const status = await stub.getOAuthConnectionStatus();
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/interactions") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const rawBody = await request.text();
      const signature = request.headers.get("X-Signature-Ed25519");
      const timestamp = request.headers.get("X-Signature-Timestamp");
      if (
        !verifyDiscordSignature(
          env.DISCORD_PUBLIC_KEY,
          signature,
          timestamp,
          rawBody,
        )
      ) {
        return new Response("Invalid request signature", { status: 401 });
      }

      const interaction = JSON.parse(rawBody) as Interaction;
      if (interaction.type === InteractionType.PING) {
        return new Response(
          JSON.stringify({ type: InteractionResponseType.PONG }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return handleInteraction(interaction, env, ctx);
    }

    // Agents SDK surface (per-org agent instances).
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const report = await runDriftCheck(env);
    console.log("drift check:", report.summary);
    // Record the verdict on the default org agent so /status tooling and
    // future dashboards can see the last check without reading logs.
    ctx.waitUntil(
      (async () => {
        try {
          const stub = await getAgentByName(
            env.PUBLISHING_AGENT as unknown as DurableObjectNamespace<PublishingAgent>,
            `org:${env.BUFFER_ORGANIZATION_ID}`,
          );
          await stub.recordDriftCheck(report.summary);
        } catch (err) {
          console.error("recording drift check failed", err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

# Discord Buffer Agent

Run your Buffer publishing from inside Discord: slash commands and approval
buttons on the front, a durable agent holding your publishing state behind
them, and Buffer's newest ContentItem API at the core — with a watcher that
tells you when that (experimental) API changes underneath you.

Built for Buffer Commit. Working name; not yet deployed.

## Why it exists

Small teams, agencies, and communities already live in Discord — but their
publishing lives somewhere else, in a dashboard nobody opens. This app moves
the whole loop into the chat they're already in: draft a post, open a thread
around it, attach channels one at a time, approve with a tap, and let the post
go out — never without a human approving the exact content first.

## Architecture

```
Discord (slash commands / buttons)
        │  HTTP interactions, Ed25519-signed
        ▼
Cloudflare Worker  ── verifies signature BEFORE any handling (401 otherwise)
        │  PING/PONG · command router · deferred follow-ups
        ▼
PublishingAgent (Cloudflare Agents SDK, one durable agent per org)
        │  ContentItem ↔ thread mapping · draft state · approval records
        │  THE APPROVAL GATE: schedule path refuses without a live,
        │  unexpired approval bound to the item's current content version
        ▼
BufferRail (one interface, two rails, same GraphQL documents)
        ├─ PRIMARY  Direct GraphQL     https://api.buffer.com
        │           Buffer OAuth access token when a grant is connected
        │           (Authorization Code + PKCE — see "Connect Buffer"
        │           below), personal API key as the standing fallback ·
        │           API-first (Mike, 2026-10-24) ·
        │           the pattern live-validated in content-management-hub
        │           PR #48 — fronted by our own Buffer MCP proxy once
        │           it deploys (~/workspace/buffer-project/proxy/)
        └─ DEV ONLY Buffer MCP server  https://mcp.buffer.com/mcp
                    explicit BUFFER_RAIL=mcp opt-in · never a product
                    dependency

Drift watcher (Worker cron, every 6h)
        introspect_schema (or docs scan fallback) vs pinned snapshot
        in src/drift/contentitem-snapshot.json → Discord webhook alert
```

Publisher OS / Content Pipeline stays canonical for source content and
provenance. Buffer is the distribution layer. This agent is the workflow
surface between them.

## Commands

| Command | What it does |
|---|---|
| `/draft <text> [title] [target_date]` | Creates a channel-less ContentItem draft in Buffer and opens a thread on the message as the item's editorial room |
| `/attach <channel_id> [item_id]` | First channel promotes the draft to PostContent (draft Posts); the item defaults to the current thread's item |
| `/queue` | Everything awaiting approval, approved, or scheduled |
| `/approve <item_id>` | Records a human approval — bound to the item's current content version, expires in 24h |
| `/status [item_id]` | Phase, posts per channel, approval state, last read-back verification |

Buttons on item messages mirror the gate: **Approve** → **Schedule** /
**Revoke approval** / **Status**. Any content change (attach/detach) bumps
the item's content version and silently invalidates earlier approvals —
re-approval is required, and the schedule path says so when refused.

## Setup

### 1. Create the Discord application

1. Discord Developer Portal → New Application (name it whatever you like).
2. Note the **Application ID** and **Public Key** (General Information).
3. Bot tab → create the bot, note the **Bot Token**.
4. Install the bot into your server with the `bot` + `applications.commands`
   scopes (permissions: send messages, create public threads).
5. In this Worker, set the **Interactions Endpoint URL** (General
   Information) to `https://<your-worker-host>/interactions`. Discord will
   PING it — the Worker answers only if its secrets are already set, so do
   step 3 first.

### 2. Connect Buffer — OAuth (primary) and/or API key (fallback)

**OAuth — the contest/product connection.** The app connects through
Buffer OAuth 2.0 (Authorization Code + PKCE, S256), per
[Buffer's authentication guide](https://developers.buffer.com/guides/authentication.html):

1. Register an App Client at **publish.buffer.com → Settings → API →
   App Clients**, and check **Public client (no client secret)** — this
   deployment uses a public client, so PKCE alone authenticates the
   token exchange and no client secret exists to store or leak. (The
   code also supports a confidential client: if
   `BUFFER_OAUTH_CLIENT_SECRET` is set, it is sent on token calls;
   when it is absent, it is never sent.)
2. On that App Client, register the redirect URI for this deployment
   exactly as: `https://<your-worker-host>/oauth/callback`
3. Set the OAuth values on the Worker (step 3 below):
   `BUFFER_OAUTH_CLIENT_ID` and `BUFFER_OAUTH_REDIRECT_URI` (the same
   redirect URI).
4. After deploying, visit `https://<your-worker-host>/oauth/start` and
   approve the connection in Buffer. The Worker stores the resulting
   token set on the dedicated `oauth` PublishingAgent instance (Durable
   Object storage); check it any time at `/oauth/status`, which returns
   only `{connected, expiresAt, scope}` — never a token value.

Scopes requested: `posts:read posts:write account:read offline_access`
(the minimum the app uses; `offline_access` is what makes Buffer issue
a refresh token). Access tokens live for one hour. **Refresh tokens
are single-use and rotate:** every refresh returns a new refresh token
and spends the old one, and reusing a spent one revokes the grant. The
agent refreshes inside the `oauth` instance — the only refresh call
site — and persists the rotated set before returning the new access
token. When an OAuth token answers 401, the GraphQL client forces
exactly one refresh and retries; if that fails it falls back to the
API key for the call.

**API key — fallback rail.** Buffer Settings → API → create an API
key. The GraphQL rail uses it directly against api.buffer.com when no
OAuth grant is connected (or as the per-call fallback above); the same
key also authenticates Buffer's hosted MCP (verified 2026-10-24). A
personal access token with `posts:write` (BUFFER_ACCESS_TOKEN) is
accepted as an alternate name for the same rail. Either credential
alone is enough to run; OAuth is preferred whenever both exist.

- Note your Buffer **organization ID**.

### 3. Configure secrets (names only — values never go in files or git)

```bash
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put BUFFER_OAUTH_CLIENT_ID     # OAuth App Client (step 2)
wrangler secret put BUFFER_OAUTH_CLIENT_SECRET # OAuth App Client (step 2)
wrangler secret put BUFFER_OAUTH_REDIRECT_URI  # https://<worker-host>/oauth/callback
wrangler secret put BUFFER_API_KEY            # fallback rail
wrangler secret put BUFFER_ACCESS_TOKEN       # fallback rail (optional alt name)
wrangler secret put BUFFER_ORGANIZATION_ID
wrangler secret put DRIFT_ALERT_WEBHOOK_URL   # optional, drift alerts
```

For local development, put the same names in `.dev.vars` (git-ignored).

### 4. Register commands and deploy

```bash
npm install
DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=… npm run register-commands
npm run deploy
```

Guild-scoped registration (with `DISCORD_GUILD_ID`) propagates instantly and
is the right choice for development; omit it for global commands.

## What's working vs stubbed

**Working (code-complete, typechecked, bundle-verified):**

- Ed25519 interaction verification (tweetnacl) before any handling; PING/PONG.
- Command router + all five command handlers + button handlers, deferred
  follow-up flow, thread-per-item creation.
- The approval gate, enforced in the agent: version-bound, expiring,
  revocable approvals; `scheduleItem` is the only scheduling path and it
  refuses without one.
- Durable per-org state; alarm-based follow-ups that verify items against
  Buffer by read-back and record the verdict.
- Buffer OAuth 2.0 connection (Authorization Code + PKCE): /oauth/start,
  /oauth/callback, /oauth/status routes; token set held in Durable
  Object storage on the dedicated `oauth` agent instance; single-use
  rotating refresh handled in exactly one place, with the API-key rail
  as the automatic per-call fallback. Client registration is external
  (publish.buffer.com → Settings → API) — the Worker only reads the
  client id/secret/redirect URI from its secrets.
- Buffer MCP client: initialize handshake, JSON-RPC over Streamable HTTP
  (JSON + SSE responses), named tools, and the advanced trio.
- GraphQL fallback client: all six ContentItem operations.
- Drift watcher: introspection diff (docs-scan fallback) vs the pinned
  2026-10-24 snapshot (pinned from the live schema, not the docs);
  webhook alert on drift.

**Confirmed live 2026-10-31 (Buffer Commit hackathon lane; transcripts in
`~/workspace/buffer-project/hackathon-2026-10-31/`, results in TEST-BATCH.md):**

- `schedulePost` is implemented in BOTH rails behind the approval gate.
  The operation is `editPost`: the rail reads the Post back, re-supplies
  its text (editPost validates the whole post — scheduling without text
  fails with "Invalid post: Post must have either text or media."), and
  sends mode `customScheduled` + dueAt + `saveToDraft: false`. The queue
  variant (mode `addToQueue`) and revert (`saveToDraft: true`) were
  confirmed in the same run.
- `attachChannel` for an *additional* channel is implemented as the
  confirmed composition: standalone `createPost` (draft) +
  `addPostToContentItem`. Both halves live-verified, incl. detach.
- The relationship documents were corrected to the live union shapes
  (Success | `VoidMutationError` — no `*Failure` type, no `message` on
  Success); the previous documents failed live validation.
- The drift watcher's schema source moved from the hosted MCP's
  `introspect_schema` to direct GraphQL introspection: Buffer REMOVED
  the advanced trio (`introspect_schema` / `execute_query` /
  `execute_mutation`) from the hosted MCP server (17 tools on 2026-10-31
  vs 20 on 2026-10-24). The hosted-MCP rail is therefore transport-broken
  upstream today; the GraphQL rail is the working rail — the exact
  contingency the API-first decision was made for. The ContentItem
  surface itself shows NO drift vs the 2026-10-24 pin.

**Still open:**

- Buffer OAuth is code-complete and bundle-verified, but NOT yet
  live-verified: no App Client has been registered at
  publish.buffer.com yet, so no end-to-end authorize → callback →
  refresh run has happened against the real auth server. The first
  deploy with the OAuth secrets set is where that proof runs
  (/oauth/start → approve → /oauth/status shows connected).
- MCP named-tool argument shapes (`create_post`, `get_metrics`, …) are
  pass-through wrappers until checked against the live server.
- Drift watcher does not yet file CARD claims (alert only) — hook marked in
  `src/drift/watcher.ts`.
- Target-date nudges are scheduled and recorded; posting them into item
  threads is TODO in the agent's follow-up handler.
- The GraphQL rail is the default by configuration (API-first, Mike
  2026-10-24); Buffer's hosted MCP rail runs only under an explicit
  BUFFER_RAIL=mcp opt-in for development. Production routing goes
  through our own Buffer MCP proxy once it deploys.

## Layout

```
src/index.ts                  Worker entry: routes, cron
src/discord/verify.ts         Ed25519 signature verification
src/discord/types.ts          interaction types, button id scheme
src/discord/commands.ts       slash command definitions
src/discord/handlers.ts       command + button handlers
src/discord/rest.ts           bot REST: follow-ups, threads
src/agent/publishing-agent.ts durable per-org agent + approval gate
src/buffer/rail.ts            BufferRail interface + rail selection
src/buffer/mcp-client.ts      dev-only rail: Buffer hosted MCP client
src/buffer/client.ts          primary rail: direct GraphQL client (OAuth-first, API-key fallback)
src/buffer/oauth.ts           Buffer OAuth 2.0: PKCE, authorize URL, token exchange/refresh
src/buffer/queries.ts         shared GraphQL documents (both rails)
src/buffer/types.ts           Buffer API types
src/drift/watcher.ts          schema-drift watcher
src/drift/contentitem-snapshot.json   pinned 2026-10-24 ContentItem surface
scripts/register-commands.ts  one-time slash command registration
```

## Safety rules baked in

- Official Discord Bot API only. No gateway bot to babysit, no user-account
  automation.
- No scheduling or publishing without a human approval tap — enforced in
  code, not convention.
- Secrets only via Worker secrets / `.dev.vars`; none in source, ever.
- Every state change verified by read-back from Buffer.

/**
 * PublishingAgent — one durable agent per Buffer organization.
 *
 * Holds the publishing state Discord can't: ContentItem ↔ Discord thread
 * mapping, draft state, channel posts, and approval records. Publisher OS
 * remains canonical for source content and provenance; this agent tracks
 * the distribution workflow around Buffer, it does not replace the CMS.
 *
 * THE APPROVAL GATE (standing rule, CCW-2292): nothing schedules or
 * publishes without a human approval tap. That is enforced here, in code:
 *  - `approveItem` records an approval bound to the item's CURRENT
 *    contentVersion.
 *  - Every content change (attach/detach/retext) bumps contentVersion,
 *    which invalidates any earlier approval.
 *  - `scheduleItem` — the only path that reaches a scheduling call —
 *    refuses unless a live, unexpired, version-matching approval exists.
 * There is no other route from this class to a schedule/publish call.
 */
import { Agent, callable, getAgentByName } from "agents";
import type { Env } from "../env";
import {
  createBufferRail,
  type BufferRail,
  type BufferRailEnv,
} from "../buffer/rail";
import {
  OAUTH_AGENT_INSTANCE,
  OAUTH_PENDING_STORAGE_KEY,
  OAUTH_TOKENS_STORAGE_KEY,
  getOAuthConfig,
  isAccessTokenExpired,
  isPendingFlowExpired,
  refreshAccessTokens,
  type BufferTokenSet,
  type PendingOAuthFlow,
} from "../buffer/oauth";

export type { BufferTokenSet, PendingOAuthFlow } from "../buffer/oauth";

export interface OAuthConnectionStatus {
  connected: boolean;
  /** ISO timestamp of access-token expiry, or null when not connected. */
  expiresAt: string | null;
  /** Granted scope string, or null when not connected. Never a token. */
  scope: string | null;
}

export type ItemPhase =
  | "draft"
  | "post_content"
  | "approved"
  | "scheduled"
  | "published";

export interface TrackedPost {
  postId: string;
  channelId: string;
  channelName?: string | null;
}

export interface TrackedItem {
  contentItemId: string;
  title?: string | null;
  draftText?: string;
  targetDate?: string | null;
  phase: ItemPhase;
  posts: TrackedPost[];
  /** Bumped on every content change; approvals bind to a version. */
  contentVersion: number;
  discordThreadId?: string;
  discordMessageId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  lastVerification?: string;
}

export interface ApprovalRecord {
  itemId: string;
  contentVersion: number;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  status: "approved" | "revoked";
}

export interface OrgState {
  organizationId: string;
  items: Record<string, TrackedItem>;
  approvals: Record<string, ApprovalRecord>;
  lastDriftCheckAt?: string;
  lastDriftSummary?: string;
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // approvals expire after 24h

export class PublishingAgent extends Agent<Env, OrgState> {
  initialState: OrgState = {
    organizationId: "",
    items: {},
    approvals: {},
  };

  async onStart(): Promise<void> {
    if (!this.state.organizationId) {
      this.setState({
        ...this.state,
        organizationId: this.env.BUFFER_ORGANIZATION_ID ?? "",
      });
    }
  }

  /** The configured Buffer access rail (GraphQL primary, MCP dev-only). */
  private _rail: BufferRail | null = null;
  private rail(): BufferRail {
    if (!this._rail) {
      // OAuth-first wiring (Buffer Commit): the GraphQL client asks
      // these providers for an access token before using the API key.
      // Resolution goes through the dedicated "oauth" agent instance,
      // which owns the token set — see the OAuth section below.
      const railEnv: BufferRailEnv = {
        BUFFER_API_KEY: this.env.BUFFER_API_KEY,
        BUFFER_ACCESS_TOKEN: this.env.BUFFER_ACCESS_TOKEN,
        BUFFER_ORGANIZATION_ID: this.env.BUFFER_ORGANIZATION_ID,
        BUFFER_RAIL: this.env.BUFFER_RAIL,
        getOAuthAccessToken: () => this.resolveOAuthAccessToken(false),
        refreshOAuthAccessToken: () => this.resolveOAuthAccessToken(true),
      };
      this._rail = createBufferRail(railEnv);
    }
    return this._rail;
  }

  /**
   * Resolve an OAuth access token from the dedicated "oauth" instance.
   * When THIS instance is the oauth instance, answer locally — a Durable
   * Object must never RPC its own stub while handling a call (the call
   * would queue behind itself). Any failure resolves to null, which the
   * GraphQL client reads as "no OAuth grant — use the API-key rail".
   * Token values cross only between Durable Objects inside this Worker;
   * they are never logged here.
   */
  private async resolveOAuthAccessToken(
    forceRefresh: boolean,
  ): Promise<string | null> {
    try {
      if (this.name === OAUTH_AGENT_INSTANCE) {
        return await this.getOAuthAccessToken(forceRefresh);
      }
      const stub = await getAgentByName(
        this.env.PUBLISHING_AGENT as unknown as DurableObjectNamespace<PublishingAgent>,
        OAUTH_AGENT_INSTANCE,
      );
      return await stub.getOAuthAccessToken(forceRefresh);
    } catch (err) {
      console.log(
        "buffer oauth: token resolution failed — API-key rail will serve",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------

  @callable()
  async createDraft(input: {
    text: string;
    createdBy: string;
    title?: string;
    targetDate?: string;
  }): Promise<TrackedItem> {
    const created = await this.rail().createContentItemDraft({
      organizationId: this.state.organizationId,
      // Live input shape: the content nests under `draft` — there is no
      // top-level text on CreateContentItemDraftInput (2026-10-24).
      draft: { text: input.text },
      title: input.title,
      targetDate: input.targetDate,
    });

    const now = new Date().toISOString();
    const item: TrackedItem = {
      contentItemId: created.id,
      title: created.title ?? input.title ?? null,
      draftText: input.text,
      targetDate: created.targetDate ?? input.targetDate ?? null,
      phase: "draft",
      posts: [],
      contentVersion: 1,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.setState({
      ...this.state,
      items: { ...this.state.items, [item.contentItemId]: item },
    });

    // Follow-up skeleton: verify the draft by read-back shortly after
    // creation, then again near its target date (alarm, not cron glue).
    await this.schedule(60, "followUp", {
      itemId: item.contentItemId,
      kind: "verify",
    });
    if (item.targetDate) {
      await this.schedule(new Date(item.targetDate), "followUp", {
        itemId: item.contentItemId,
        kind: "target-date-nudge",
      });
    }
    return item;
  }

  @callable()
  async registerThread(input: {
    itemId: string;
    threadId: string;
    messageId?: string;
  }): Promise<TrackedItem> {
    const item = this.requireItem(input.itemId);
    const updated: TrackedItem = {
      ...item,
      discordThreadId: input.threadId,
      discordMessageId: input.messageId,
      updatedAt: new Date().toISOString(),
    };
    this.putItem(updated);
    return updated;
  }

  // ---------------------------------------------------------------
  // Channel expansion (post-promotion attach — the workflow from
  // Mike's Buffer feedback: publish LinkedIn today, add Instagram
  // later, same logical item)
  // ---------------------------------------------------------------

  @callable()
  async attachChannel(input: {
    itemId: string;
    channelId: string;
  }): Promise<TrackedItem> {
    const item = this.requireItem(input.itemId);

    if (item.phase === "draft") {
      // First channel: promotion moves the item into PostContent and
      // creates the channel's draft Post.
      const promoted = await this.rail().promoteContentItemDraftToPosts({
        contentItemId: item.contentItemId,
        // Live input shape: posts: [CreatePostInput] — one entry per
        // channel (2026-10-24). saveToDraft keeps the new Post a draft;
        // the text must be re-supplied from the tracked draft because
        // the API does not carry the draft body into the Post (and
        // promotion without text fails — TEST-BATCH T1).
        posts: [
          {
            channelId: input.channelId,
            mode: "addToQueue",
            schedulingType: "automatic",
            saveToDraft: true,
            text: item.draftText,
          },
        ],
      });
      const posts = (promoted.body?.posts ?? []).map((p) => ({
        postId: p.id,
        channelId: p.channel?.id ?? input.channelId,
        channelName: p.channel?.name ?? null,
      }));
      const updated: TrackedItem = {
        ...item,
        phase: "post_content",
        posts,
        contentVersion: item.contentVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      this.putItem(updated);
      await this.verifyItem(updated.contentItemId);
      return updated;
    }

    // Already PostContent: the Buffer flow is "create the channel Post,
    // then attach it" — both halves live-verified 2026-10-31 (standalone
    // createPost as a draft + addPostToContentItem, hackathon probes).
    // The new channel Post is created as a DRAFT carrying the tracked
    // draft text; scheduling still sits behind the approval gate.
    const created = await this.rail().createChannelPost({
      channelId: input.channelId,
      mode: "addToQueue",
      schedulingType: "automatic",
      saveToDraft: true,
      text: item.draftText,
    });
    const result = await this.rail().addPostToContentItem(
      item.contentItemId,
      created.id,
    );
    const posts = (result.contentItem?.body?.posts ?? []).map((p) => ({
      postId: p.id,
      channelId: p.channel?.id ?? "unknown",
      channelName: p.channel?.name ?? null,
    }));
    const updated: TrackedItem = {
      ...item,
      phase: "post_content",
      posts: posts.length ? posts : item.posts,
      contentVersion: item.contentVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.putItem(updated);
    await this.verifyItem(updated.contentItemId);
    return updated;
  }

  @callable()
  async attachPost(input: {
    itemId: string;
    postId: string;
  }): Promise<TrackedItem> {
    const item = this.requireItem(input.itemId);
    const result = await this.rail().addPostToContentItem(item.contentItemId, input.postId);
    const posts = (result.contentItem?.body?.posts ?? []).map((p) => ({
      postId: p.id,
      channelId: p.channel?.id ?? "unknown",
      channelName: p.channel?.name ?? null,
    }));
    const updated: TrackedItem = {
      ...item,
      phase: "post_content",
      posts: posts.length ? posts : item.posts,
      contentVersion: item.contentVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.putItem(updated);
    await this.verifyItem(updated.contentItemId);
    return updated;
  }

  @callable()
  async detachPost(input: {
    itemId: string;
    postId: string;
  }): Promise<TrackedItem> {
    const item = this.requireItem(input.itemId);
    await this.rail().removePostFromContentItem(item.contentItemId, input.postId);
    const updated: TrackedItem = {
      ...item,
      posts: item.posts.filter((p) => p.postId !== input.postId),
      contentVersion: item.contentVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.putItem(updated);
    await this.verifyItem(updated.contentItemId);
    return updated;
  }

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  @callable()
  async listQueue(): Promise<TrackedItem[]> {
    return Object.values(this.state.items)
      .filter((i) => i.phase !== "published")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  @callable()
  async getStatus(itemId?: string): Promise<TrackedItem | TrackedItem[]> {
    if (itemId) return this.requireItem(itemId);
    return Object.values(this.state.items);
  }

  @callable()
  async findItemByThread(threadId: string): Promise<TrackedItem | null> {
    return (
      Object.values(this.state.items).find(
        (i) => i.discordThreadId === threadId,
      ) ?? null
    );
  }

  // ---------------------------------------------------------------
  // The approval gate
  // ---------------------------------------------------------------

  @callable()
  async approveItem(input: {
    itemId: string;
    approvedBy: string;
  }): Promise<ApprovalRecord> {
    const item = this.requireItem(input.itemId);
    if (item.phase === "draft" || item.posts.length === 0) {
      throw new Error(
        "Item has no channel Posts yet — attach a channel before approving",
      );
    }
    const now = new Date();
    const record: ApprovalRecord = {
      itemId: item.contentItemId,
      contentVersion: item.contentVersion,
      approvedBy: input.approvedBy,
      approvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      status: "approved",
    };
    this.setState({
      ...this.state,
      approvals: { ...this.state.approvals, [item.contentItemId]: record },
      items: {
        ...this.state.items,
        [item.contentItemId]: { ...item, phase: "approved" },
      },
    });
    return record;
  }

  @callable()
  async revokeApproval(input: { itemId: string }): Promise<void> {
    const existing = this.state.approvals[input.itemId];
    if (!existing) return;
    const item = this.state.items[input.itemId];
    this.setState({
      ...this.state,
      approvals: {
        ...this.state.approvals,
        [input.itemId]: { ...existing, status: "revoked" },
      },
      items: item
        ? {
            ...this.state.items,
            [input.itemId]: { ...item, phase: "post_content" as ItemPhase },
          }
        : this.state.items,
    });
  }

  /**
   * The ONLY scheduling path. Refuses — by throwing ApprovalRequiredError —
   * unless a live approval record exists for the item's exact current
   * content version. The Buffer operation behind it (editPost) was
   * confirmed live 2026-10-31 — see buffer/client.schedulePost.
   */
  @callable()
  async scheduleItem(input: {
    itemId: string;
    scheduledAt: string;
  }): Promise<TrackedItem> {
    const item = this.requireItem(input.itemId);
    this.assertApproved(item); // ← the gate. No record, no schedule. Ever.

    for (const post of item.posts) {
      await this.rail().schedulePost(post.postId, input.scheduledAt);
    }
    const updated: TrackedItem = {
      ...item,
      phase: "scheduled",
      updatedAt: new Date().toISOString(),
    };
    this.putItem(updated);
    await this.schedule(new Date(input.scheduledAt), "followUp", {
      itemId: item.contentItemId,
      kind: "post-publish-verify",
    });
    return updated;
  }

  private assertApproved(item: TrackedItem): void {
    const record = this.state.approvals[item.contentItemId];
    if (!record || record.status !== "approved") {
      throw new ApprovalRequiredError(
        `No approval on record for item ${item.contentItemId} — a human must tap Approve first`,
      );
    }
    if (record.contentVersion !== item.contentVersion) {
      throw new ApprovalRequiredError(
        `Approval was for content version ${record.contentVersion} but the item is now version ${item.contentVersion} — content changed after approval, re-approval required`,
      );
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      throw new ApprovalRequiredError(
        `Approval for item ${item.contentItemId} expired at ${record.expiresAt} — re-approval required`,
      );
    }
  }

  // ---------------------------------------------------------------
  // Alarm follow-ups (scheduled via this.schedule, not cron)
  // ---------------------------------------------------------------

  async followUp(payload: {
    itemId: string;
    kind: "verify" | "target-date-nudge" | "post-publish-verify";
  }): Promise<void> {
    const item = this.state.items[payload.itemId];
    if (!item) return;
    if (payload.kind === "verify" || payload.kind === "post-publish-verify") {
      await this.verifyItem(payload.itemId);
    }
    // "target-date-nudge": state is recorded; surfacing the nudge in the
    // item's Discord thread is wired in the interactions layer (TODO:
    // needs the bot REST client, src/discord/rest.ts).
  }

  /** Verify local state against Buffer by read-back; record the verdict. */
  private async verifyItem(itemId: string): Promise<void> {
    const item = this.state.items[itemId];
    if (!item) return;
    try {
      const remote = await this.rail().getContentItem(itemId);
      const remotePosts = remote.body?.posts ?? [];
      const note =
        item.phase === "draft"
          ? `read-back ok: still draft (${remote.body?.__typename ?? "unknown body"})`
          : `read-back ok: ${remotePosts.length} post(s) on Buffer, ${item.posts.length} tracked locally`;
      this.putItem({
        ...item,
        lastVerifiedAt: new Date().toISOString(),
        lastVerification: note,
      });
    } catch (err) {
      this.putItem({
        ...item,
        lastVerifiedAt: new Date().toISOString(),
        lastVerification: `read-back FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ---------------------------------------------------------------
  // Buffer OAuth (Buffer Commit eligibility — src/buffer/oauth.ts)
  //
  // Token state lives ONLY on the dedicated instance named "oauth"
  // (OAUTH_AGENT_INSTANCE), in that instance's Durable Object storage
  // under keyed entries — never in OrgState, because setState state is
  // broadcast-shaped publishing state, while storage entries stay
  // inside the instance. The Worker routes (/oauth/start, /oauth/
  // callback, /oauth/status in src/index.ts) talk to that instance;
  // per-org instances read tokens from it through
  // resolveOAuthAccessToken() above.
  //
  // Refresh tokens are SINGLE-USE and rotate: getOAuthAccessToken is
  // the only refresh call site, and it persists the rotated token set
  // returned by the token endpoint BEFORE returning the new access
  // token, discarding the spent refresh token with it.
  // ---------------------------------------------------------------

  /** Store a pending authorize flow (state → verifier), pruning expired. */
  @callable()
  async beginOAuthFlow(flow: PendingOAuthFlow): Promise<void> {
    const all =
      (await this.ctx.storage.get<Record<string, PendingOAuthFlow>>(
        OAUTH_PENDING_STORAGE_KEY,
      )) ?? {};
    const kept: Record<string, PendingOAuthFlow> = {};
    for (const [state, pending] of Object.entries(all)) {
      if (!isPendingFlowExpired(pending)) kept[state] = pending;
    }
    kept[flow.state] = flow;
    await this.ctx.storage.put(OAUTH_PENDING_STORAGE_KEY, kept);
  }

  /**
   * Consume a pending flow by state: single-use (the entry is deleted
   * whether it is valid, expired, or unknown-state-adjacent) and
   * expired flows (older than OAUTH_PENDING_TTL_MS, 10 min) read as
   * absent. Returns the flow so the callback can use its PKCE verifier.
   */
  @callable()
  async consumeOAuthPending(
    state: string,
  ): Promise<PendingOAuthFlow | null> {
    const all =
      (await this.ctx.storage.get<Record<string, PendingOAuthFlow>>(
        OAUTH_PENDING_STORAGE_KEY,
      )) ?? {};
    const flow = all[state];
    if (!flow) return null;
    const kept: Record<string, PendingOAuthFlow> = {};
    for (const [key, pending] of Object.entries(all)) {
      if (key !== state && !isPendingFlowExpired(pending)) {
        kept[key] = pending;
      }
    }
    await this.ctx.storage.put(OAUTH_PENDING_STORAGE_KEY, kept);
    return isPendingFlowExpired(flow) ? null : flow;
  }

  /** Persist a token set (from code exchange or a completed refresh). */
  @callable()
  async saveOAuthTokens(tokens: BufferTokenSet): Promise<void> {
    await this.ctx.storage.put(OAUTH_TOKENS_STORAGE_KEY, tokens);
  }

  /** Load the stored token set, or null when no grant exists. */
  @callable()
  async loadOAuthTokens(): Promise<BufferTokenSet | null> {
    return (
      (await this.ctx.storage.get<BufferTokenSet>(
        OAUTH_TOKENS_STORAGE_KEY,
      )) ?? null
    );
  }

  /** Drop the stored grant (disconnect). Does not revoke at Buffer. */
  @callable()
  async clearOAuthTokens(): Promise<void> {
    await this.ctx.storage.delete(OAUTH_TOKENS_STORAGE_KEY);
  }

  /**
   * Connection metadata for /oauth/status — expiry and scope only.
   * Never returns an access or refresh token value.
   */
  @callable()
  async getOAuthConnectionStatus(): Promise<OAuthConnectionStatus> {
    const tokens = await this.loadOAuthTokens();
    if (!tokens) {
      return { connected: false, expiresAt: null, scope: null };
    }
    return {
      connected:
        !isAccessTokenExpired(tokens, Date.now(), 0) ||
        tokens.refreshToken !== null,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
      scope: tokens.scope,
    };
  }

  /**
   * A usable OAuth access token, or null when none can be produced.
   * Serves the stored token while it is valid; when it is expired (or
   * forceRefresh follows a 401) it performs the refresh HERE, on the
   * instance that owns the storage, and persists the ROTATED token set
   * — new refresh token in, spent one discarded — before returning.
   * Refresh failure resolves to null (never throws to the rail), which
   * the GraphQL client treats as "fall back to the API-key rail".
   */
  @callable()
  async getOAuthAccessToken(
    forceRefresh: boolean = false,
  ): Promise<string | null> {
    const tokens = await this.loadOAuthTokens();
    if (!tokens) return null;
    if (!forceRefresh && !isAccessTokenExpired(tokens)) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      // Expired (or rejected) with no way to refresh: only an unexpired
      // token could still serve, and a forced call means it did not.
      return !isAccessTokenExpired(tokens, Date.now(), 0)
        ? tokens.accessToken
        : null;
    }
    const config = getOAuthConfig(this.env);
    if (!config) {
      return !isAccessTokenExpired(tokens, Date.now(), 0)
        ? tokens.accessToken
        : null;
    }
    try {
      const rotated = await refreshAccessTokens({
        config,
        refreshToken: tokens.refreshToken,
      });
      await this.saveOAuthTokens(rotated);
      console.log(
        "buffer oauth: access token refreshed; rotated refresh token persisted",
      );
      return rotated.accessToken;
    } catch (err) {
      console.error(
        "buffer oauth: refresh failed — caller falls back to API-key rail",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  // ---------------------------------------------------------------
  // Drift watcher bookkeeping
  // ---------------------------------------------------------------

  @callable()
  async recordDriftCheck(summary: string): Promise<void> {
    this.setState({
      ...this.state,
      lastDriftCheckAt: new Date().toISOString(),
      lastDriftSummary: summary,
    });
  }

  // ---------------------------------------------------------------

  private requireItem(itemId: string): TrackedItem {
    const item = this.state.items[itemId];
    if (!item) throw new Error(`Unknown item ${itemId}`);
    return item;
  }

  private putItem(item: TrackedItem): void {
    this.setState({
      ...this.state,
      items: { ...this.state.items, [item.contentItemId]: item },
    });
  }
}

/**
 * BufferRail — the single interface the agent talks to.
 *
 * Two rails implement it over the SAME GraphQL documents (queries.ts):
 *   GraphqlRail PRIMARY (Mike's decision 2026-10-24: API-first). Direct
 *               POST to https://api.buffer.com — the surface Publisher OS
 *               integrates and the pattern live-validated in
 *               content-management-hub PR #48. When our own Buffer MCP
 *               proxy deploys (~/workspace/buffer-project/proxy/), it
 *               fronts this same API and becomes the production route.
 *   McpRail     DEV / AD-HOC ONLY. Buffer's hosted MCP server
 *               (https://mcp.buffer.com/mcp) via its execute_query /
 *               execute_mutation advanced tools. Never a product
 *               dependency; selected only by explicit opt-in.
 *
 * Selection: BUFFER_RAIL="mcp" + BUFFER_API_KEY → McpRail (dev only).
 * Anything else with a credential (BUFFER_ACCESS_TOKEN or
 * BUFFER_API_KEY — the same personal API key authenticates the API
 * directly, verified 2026-10-24) → GraphqlRail. No credential → the
 * factory throws and the caller surfaces it.
 */
import type {
  BufferContentItem,
  BufferPostFull,
  BufferPostRef,
  ContentItemMutationPayload,
  ContentItemRelationshipPayload,
  ContentItemRelationshipResult,
  CreateDraftInput,
  CreatePostInput,
  PostActionPayload,
  PromoteInput,
  UpdateContentItemInput,
} from "./types";
import {
  buildAddPostToContentItem,
  buildCreatePost,
  buildCreateContentItemDraft,
  buildEditPostSchedule,
  buildGetContentItem,
  buildGetPost,
  buildGetPostFull,
  buildPromoteContentItemDraftToPosts,
  buildRemovePostFromContentItem,
  buildUpdateContentItem,
} from "./queries";
import * as graphql from "./client";
import { BufferMcpClient, unwrapGraphqlToolResult } from "./mcp-client";

export interface BufferRail {
  readonly kind: "mcp" | "graphql";
  createContentItemDraft(input: CreateDraftInput): Promise<BufferContentItem>;
  promoteContentItemDraftToPosts(
    input: PromoteInput,
  ): Promise<BufferContentItem>;
  addPostToContentItem(
    contentItemId: string,
    postId: string,
  ): Promise<ContentItemRelationshipResult>;
  removePostFromContentItem(
    contentItemId: string,
    postId: string,
  ): Promise<ContentItemRelationshipResult>;
  getPostContentItemId(postId: string): Promise<string | null>;
  getContentItem(contentItemId: string): Promise<BufferContentItem>;
  updateContentItem(input: UpdateContentItemInput): Promise<BufferContentItem>;
  getPostFull(postId: string): Promise<BufferPostFull>;
  createChannelPost(input: CreatePostInput): Promise<BufferPostFull>;
  schedulePost(postId: string, scheduledAt: string): Promise<BufferPostFull>;
}

export interface BufferRailEnv extends graphql.BufferClientEnv {
  BUFFER_ORGANIZATION_ID?: string;
  /** Explicit rail selector. "mcp" is a dev-only opt-in; default "graphql". */
  BUFFER_RAIL?: string;
}

class McpRail implements BufferRail {
  readonly kind = "mcp" as const;
  private readonly mcp: BufferMcpClient;

  constructor(env: BufferRailEnv) {
    this.mcp = new BufferMcpClient(env);
  }

  /** Exposed for the drift watcher and future tooling. */
  get client(): BufferMcpClient {
    return this.mcp;
  }

  /**
   * Mutation payloads are unions (live schema): unwrap the tool result,
   * surface a Failure payload as an error with its message (the same
   * check the GraphQL rail applies in client.ts), and return the bare
   * contentItem — so callers cannot tell which rail served the call.
   */
  private async executeItemMutation(
    mutation: string,
    operation: string,
  ): Promise<BufferContentItem> {
    const payload = unwrapGraphqlToolResult<ContentItemMutationPayload>(
      await this.mcp.executeMutation(mutation),
    );
    graphql.assertNotFailurePayload(payload);
    if (!payload?.contentItem) {
      throw new Error(`Buffer ${operation} returned no contentItem`);
    }
    return payload.contentItem;
  }

  private async executeRelationshipMutation(
    mutation: string,
  ): Promise<ContentItemRelationshipResult> {
    const payload = unwrapGraphqlToolResult<ContentItemRelationshipPayload>(
      await this.mcp.executeMutation(mutation),
    );
    graphql.assertNotFailurePayload(payload);
    return {
      contentItem: payload?.contentItem ?? null,
      post: payload?.post ?? null,
      message: payload?.message ?? null,
    };
  }

  async createContentItemDraft(
    input: CreateDraftInput,
  ): Promise<BufferContentItem> {
    return this.executeItemMutation(
      buildCreateContentItemDraft(input),
      "createContentItemDraft",
    );
  }

  async promoteContentItemDraftToPosts(
    input: PromoteInput,
  ): Promise<BufferContentItem> {
    return this.executeItemMutation(
      buildPromoteContentItemDraftToPosts(input),
      "promoteContentItemDraftToPosts",
    );
  }

  async addPostToContentItem(
    contentItemId: string,
    postId: string,
  ): Promise<ContentItemRelationshipResult> {
    return this.executeRelationshipMutation(
      buildAddPostToContentItem(contentItemId, postId),
    );
  }

  async removePostFromContentItem(
    contentItemId: string,
    postId: string,
  ): Promise<ContentItemRelationshipResult> {
    return this.executeRelationshipMutation(
      buildRemovePostFromContentItem(contentItemId, postId),
    );
  }

  async getPostContentItemId(postId: string): Promise<string | null> {
    const post = unwrapGraphqlToolResult<BufferPostRef>(
      await this.mcp.executeQuery(buildGetPost(postId)),
    );
    return post?.contentItemId ?? null;
  }

  async getContentItem(contentItemId: string): Promise<BufferContentItem> {
    return unwrapGraphqlToolResult<BufferContentItem>(
      await this.mcp.executeQuery(buildGetContentItem(contentItemId)),
    );
  }

  async updateContentItem(
    input: UpdateContentItemInput,
  ): Promise<BufferContentItem> {
    return this.executeItemMutation(
      buildUpdateContentItem(input),
      "updateContentItem",
    );
  }

  async getPostFull(postId: string): Promise<BufferPostFull> {
    return unwrapGraphqlToolResult<BufferPostFull>(
      await this.mcp.executeQuery(buildGetPostFull(postId)),
    );
  }

  private async executePostAction(
    mutation: string,
    operation: string,
  ): Promise<BufferPostFull> {
    const payload = unwrapGraphqlToolResult<PostActionPayload>(
      await this.mcp.executeMutation(mutation),
    );
    graphql.assertNotFailurePayload(payload);
    if (!payload?.post) {
      throw new Error(`Buffer ${operation} returned no post`);
    }
    return payload.post;
  }

  async createChannelPost(input: CreatePostInput): Promise<BufferPostFull> {
    return this.executePostAction(buildCreatePost(input), "createPost");
  }

  /**
   * Same confirmed operation as the GraphQL rail (editPost; see
   * client.schedulePost). NOTE: this runs over the hosted MCP's
   * execute_mutation advanced tool, which Buffer REMOVED from the hosted
   * server's tool list (verified 2026-10-31: 17 tools, no advanced
   * trio) — so this rail currently fails at the transport and the
   * GraphQL rail is the working rail, exactly the contingency the
   * API-first decision (2026-10-24) was made for.
   */
  async schedulePost(
    postId: string,
    scheduledAt: string,
  ): Promise<BufferPostFull> {
    const current = await this.getPostFull(postId);
    if (!current.text) {
      throw new Error(
        `Cannot schedule post ${postId}: its current text could not be read back, and editPost requires the text to schedule`,
      );
    }
    return this.executePostAction(
      buildEditPostSchedule({ postId, text: current.text, scheduledAt }),
      "editPost",
    );
  }
}

class GraphqlRail implements BufferRail {
  readonly kind = "graphql" as const;

  constructor(private readonly env: BufferRailEnv) {}

  createContentItemDraft(input: CreateDraftInput) {
    return graphql.createContentItemDraft(this.env, input);
  }
  promoteContentItemDraftToPosts(input: PromoteInput) {
    return graphql.promoteContentItemDraftToPosts(this.env, input);
  }
  addPostToContentItem(contentItemId: string, postId: string) {
    return graphql.addPostToContentItem(this.env, contentItemId, postId);
  }
  removePostFromContentItem(contentItemId: string, postId: string) {
    return graphql.removePostFromContentItem(this.env, contentItemId, postId);
  }
  getPostContentItemId(postId: string) {
    return graphql.getPostContentItemId(this.env, postId);
  }
  getContentItem(contentItemId: string) {
    return graphql.getContentItem(this.env, contentItemId);
  }
  updateContentItem(input: UpdateContentItemInput) {
    return graphql.updateContentItem(this.env, input);
  }
  getPostFull(postId: string) {
    return graphql.getPostFull(this.env, postId);
  }
  createChannelPost(input: CreatePostInput) {
    return graphql.createChannelPost(this.env, input);
  }
  schedulePost(postId: string, scheduledAt: string) {
    return graphql.schedulePost(this.env, postId, scheduledAt);
  }
}

/**
 * Pick the rail: API-first by default (Mike, 2026-10-24). The hosted-MCP
 * rail runs only on explicit BUFFER_RAIL="mcp" opt-in with an API key.
 * Throws if no credential is configured — surfaced to the caller, never
 * silently degraded.
 */
export function createBufferRail(env: BufferRailEnv): BufferRail {
  if (env.BUFFER_RAIL === "mcp" && env.BUFFER_API_KEY) return new McpRail(env);
  // GraphQL rail: serves with the OAuth access token when the token
  // provider is wired and a grant exists (Buffer Commit eligibility),
  // and falls back to the personal API key per call (client.ts owns
  // that order + the one-refresh rule). Either credential suffices.
  if (env.BUFFER_ACCESS_TOKEN || env.BUFFER_API_KEY || env.getOAuthAccessToken) {
    return new GraphqlRail(env);
  }
  throw new Error(
    "No Buffer credential configured: connect Buffer OAuth (see /oauth/start) or set BUFFER_API_KEY or BUFFER_ACCESS_TOKEN (GraphQL rail, primary); BUFFER_RAIL=mcp + BUFFER_API_KEY selects the dev-only hosted-MCP rail",
  );
}

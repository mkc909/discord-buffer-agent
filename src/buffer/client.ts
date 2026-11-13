/**
 * Buffer GraphQL client — the PRIMARY rail (Mike's decision 2026-10-24:
 * API-first), ported from the content-management-hub pattern
 * (mkc909/content-management-hub, src/services/buffer-content-items.ts,
 * live-validated 2026-09-23, PR #48).
 *
 * Both rails implement the same BufferRail interface (rail.ts) over the
 * same GraphQL documents (queries.ts), so the agent above them cannot
 * tell — or depend on — which rail served a call. The hosted-MCP rail
 * (mcp-client.ts) is dev/ad-hoc only; Buffer removed its advanced
 * execute_* tools from the hosted server (verified 2026-10-31), which
 * is exactly the drift Mike's API-first decision protects against.
 *
 * Safety: scheduling lives behind the agent's approval gate
 * (src/agent/publishing-agent.ts). schedulePost below is the confirmed
 * operation (editPost, live-verified 2026-10-31) and is only reached
 * through that gate.
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

export const BUFFER_API_URL = "https://api.buffer.com";

export interface BufferClientEnv {
  BUFFER_ACCESS_TOKEN?: string;
  BUFFER_API_KEY?: string;
  /**
   * OAuth credential source (Buffer Commit rail — src/buffer/oauth.ts).
   * When supplied, the GraphQL client prefers the OAuth access token
   * over the API key:
   *  - getOAuthAccessToken returns a currently-valid access token (the
   *    provider refreshes proactively when expired), or null when no
   *    OAuth grant exists — the client then uses the API key.
   *  - refreshOAuthAccessToken forces ONE refresh after a 401 and
   *    returns the new access token (the provider persists the rotated
   *    refresh token), or null when refresh is impossible/failed — the
   *    client then falls back to the API-key rail for that call.
   * Implementations must never log token values; neither does this
   * client (it logs only which credential source served a call).
   */
  getOAuthAccessToken?: () => Promise<string | null>;
  refreshOAuthAccessToken?: () => Promise<string | null>;
}

/**
 * ContentItem mutation payloads are UNIONS (live schema, 2026-10-24): a
 * Success member carrying the result, or a Failure member carrying
 * `message` and `errors`. A Failure is a completed GraphQL response, not
 * a transport error — surface it as a thrown error with its message, on
 * both rails (rail.ts applies the same check to MCP results).
 */
export function assertNotFailurePayload(value: unknown): void {
  if (value && typeof value === "object") {
    const typename = (value as { __typename?: unknown }).__typename;
    // Failure members come in three namings across the live schema:
    // *Failure (ContentItem mutations), VoidMutationError (the add/remove
    // relationship unions), and the *Error members of PostActionPayload
    // (createPost / editPost). All carry `message`. Success members end
    // in "Success" and never match. (Live-verified 2026-10-31.)
    if (
      typeof typename === "string" &&
      (typename.endsWith("Failure") || typename.endsWith("Error"))
    ) {
      const message = (value as { message?: unknown }).message;
      throw new Error(
        `Buffer GraphQL error: ${typeof message === "string" && message ? message : typename}`,
      );
    }
  }
}

/** Unwrap a union mutation payload to its contentItem, or throw. */
function requireContentItem(
  payload: ContentItemMutationPayload,
  operation: string,
): BufferContentItem {
  if (!payload.contentItem) {
    throw new Error(`Buffer ${operation} returned no contentItem`);
  }
  return payload.contentItem;
}

interface GraphqlAttempt {
  status: number;
  ok: boolean;
  text: string;
}

/** One POST to the GraphQL endpoint with an explicit bearer token. */
async function postBufferGraphql(
  token: string,
  query: string,
): Promise<GraphqlAttempt> {
  const response = await fetch(BUFFER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

/**
 * Credential order (Buffer Commit, 2026-11-13): OAuth access token
 * first when a grant exists, API key as the standing fallback.
 *  - OAuth token valid → served by OAuth.
 *  - OAuth answers 401 → ONE forced refresh (the provider persists
 *    the rotated refresh token), retry once with the new token.
 *  - Refresh impossible or the retry also 401s, and an API key is
 *    configured → the call is served by the API-key rail instead.
 *  - No OAuth grant → API key, exactly as before.
 * Nothing here logs a token value — only the credential source.
 */
export async function executeBufferGraphql<T>(
  env: BufferClientEnv,
  query: string,
): Promise<T> {
  const apiKey = env.BUFFER_ACCESS_TOKEN ?? env.BUFFER_API_KEY;

  let oauthToken: string | null = null;
  if (env.getOAuthAccessToken) {
    try {
      oauthToken = await env.getOAuthAccessToken();
    } catch (err) {
      console.log(
        "buffer graphql: OAuth token lookup failed, using API-key rail",
        err instanceof Error ? err.message : String(err),
      );
      oauthToken = null;
    }
  }

  let attempt: GraphqlAttempt | null = null;
  if (oauthToken) {
    attempt = await postBufferGraphql(oauthToken, query);
    if (attempt.status === 401 && env.refreshOAuthAccessToken) {
      console.log(
        "buffer graphql: OAuth token rejected (401) — attempting one refresh",
      );
      let refreshed: string | null = null;
      try {
        refreshed = await env.refreshOAuthAccessToken();
      } catch (err) {
        console.log(
          "buffer graphql: OAuth refresh failed, falling back to API-key rail",
          err instanceof Error ? err.message : String(err),
        );
        refreshed = null;
      }
      if (refreshed) {
        attempt = await postBufferGraphql(refreshed, query);
      }
    }
    if (attempt.status === 401 && apiKey && apiKey !== oauthToken) {
      console.log(
        "buffer graphql: OAuth path unauthorized — falling back to API-key rail",
      );
      attempt = await postBufferGraphql(apiKey, query);
    }
  } else if (apiKey) {
    attempt = await postBufferGraphql(apiKey, query);
  }

  if (!attempt) {
    throw new Error(
      "No Buffer credential available for the GraphQL rail: no OAuth grant is connected (see /oauth/start) and no API key is configured — set BUFFER_ACCESS_TOKEN or BUFFER_API_KEY (the same personal API key authenticates api.buffer.com directly — verified 2026-10-24)",
    );
  }

  if (!attempt.ok) {
    throw new Error(
      `Buffer API error ${attempt.status}: ${attempt.text.substring(0, 300)}`,
    );
  }

  const payload = JSON.parse(attempt.text) as {
    data?: Record<string, T>;
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    throw new Error(
      `Buffer GraphQL error: ${payload.errors[0]?.message || "unknown error"}`,
    );
  }

  const value = payload.data ? Object.values(payload.data)[0] : undefined;
  assertNotFailurePayload(value);
  return (value ?? {}) as T;
}

export async function createContentItemDraft(
  env: BufferClientEnv,
  input: CreateDraftInput,
): Promise<BufferContentItem> {
  const payload = await executeBufferGraphql<ContentItemMutationPayload>(
    env,
    buildCreateContentItemDraft(input),
  );
  return requireContentItem(payload, "createContentItemDraft");
}

export async function promoteContentItemDraftToPosts(
  env: BufferClientEnv,
  input: PromoteInput,
): Promise<BufferContentItem> {
  const payload = await executeBufferGraphql<ContentItemMutationPayload>(
    env,
    buildPromoteContentItemDraftToPosts(input),
  );
  return requireContentItem(payload, "promoteContentItemDraftToPosts");
}

export async function addPostToContentItem(
  env: BufferClientEnv,
  contentItemId: string,
  postId: string,
): Promise<ContentItemRelationshipResult> {
  const payload = await executeBufferGraphql<ContentItemRelationshipPayload>(
    env,
    buildAddPostToContentItem(contentItemId, postId),
  );
  return {
    contentItem: payload.contentItem ?? null,
    post: payload.post ?? null,
    message: payload.message ?? null,
  };
}

export async function removePostFromContentItem(
  env: BufferClientEnv,
  contentItemId: string,
  postId: string,
): Promise<ContentItemRelationshipResult> {
  const payload = await executeBufferGraphql<ContentItemRelationshipPayload>(
    env,
    buildRemovePostFromContentItem(contentItemId, postId),
  );
  return {
    contentItem: payload.contentItem ?? null,
    post: payload.post ?? null,
    message: payload.message ?? null,
  };
}

export async function getPostContentItemId(
  env: BufferClientEnv,
  postId: string,
): Promise<string | null> {
  const post = await executeBufferGraphql<BufferPostRef>(
    env,
    buildGetPost(postId),
  );
  return post?.contentItemId ?? null;
}

export async function getContentItem(
  env: BufferClientEnv,
  contentItemId: string,
): Promise<BufferContentItem> {
  return executeBufferGraphql<BufferContentItem>(
    env,
    buildGetContentItem(contentItemId),
  );
}

export async function updateContentItem(
  env: BufferClientEnv,
  input: UpdateContentItemInput,
): Promise<BufferContentItem> {
  const payload = await executeBufferGraphql<ContentItemMutationPayload>(
    env,
    buildUpdateContentItem(input),
  );
  return requireContentItem(payload, "updateContentItem");
}

/** Read one Post in full (status, text, schedule fields). */
export async function getPostFull(
  env: BufferClientEnv,
  postId: string,
): Promise<BufferPostFull> {
  return executeBufferGraphql<BufferPostFull>(env, buildGetPostFull(postId));
}

/**
 * Create a standalone channel Post (draft-first unless the caller opts
 * out). The create half of the attachChannel composition; live-verified
 * 2026-10-31 together with addPostToContentItem.
 */
export async function createChannelPost(
  env: BufferClientEnv,
  input: CreatePostInput,
): Promise<BufferPostFull> {
  const payload = await executeBufferGraphql<PostActionPayload>(
    env,
    buildCreatePost(input),
  );
  if (!payload.post) {
    throw new Error("Buffer createPost returned no post");
  }
  return payload.post;
}

/**
 * Schedule an existing Post at an exact time — CONFIRMED live 2026-10-31
 * (hackathon probe transcripts in ~/workspace/buffer-project/
 * hackathon-2026-10-31/): editPost { id, text, mode: customScheduled,
 * dueAt, saveToDraft: false } moves a draft Post to status "scheduled"
 * with isCustomScheduled true. The text is re-supplied from a fresh read
 * because editPost validates the whole post and rejects scheduling
 * changes without it ("Invalid post: Post must have either text or
 * media."). Only ever called behind the agent's approval gate.
 */
export async function schedulePost(
  env: BufferClientEnv,
  postId: string,
  scheduledAt: string,
): Promise<BufferPostFull> {
  const current = await getPostFull(env, postId);
  if (!current.text) {
    throw new Error(
      `Cannot schedule post ${postId}: its current text could not be read back, and editPost requires the text to schedule`,
    );
  }
  const payload = await executeBufferGraphql<PostActionPayload>(
    env,
    buildEditPostSchedule({ postId, text: current.text, scheduledAt }),
  );
  if (!payload.post) {
    throw new Error("Buffer editPost returned no post");
  }
  return payload.post;
}

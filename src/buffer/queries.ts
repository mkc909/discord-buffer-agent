/**
 * GraphQL document builders for the Buffer ContentItem surface.
 *
 * Shared by BOTH access rails so they can never drift from each other:
 *  - GraphQL rail (client.ts): POSTs these documents to https://api.buffer.com
 *  - MCP rail (mcp-client.ts): passes them to Buffer MCP's execute_query /
 *    execute_mutation advanced tools
 *
 * Shapes verified against the LIVE schema on 2026-10-24 (authenticated
 * introspection + live execute_query/execute_mutation run — see
 * ~/workspace/buffer-project/TEST-BATCH.md, results + schema-drift
 * sections). Two guide-era shapes were WRONG and are fixed here:
 * createContentItemDraft nests its content under `draft` (no top-level
 * text), and promoteContentItemDraftToPosts takes `posts:
 * [CreatePostInput]` (not channelIds). The contentItem query likewise
 * takes `input: { id }`, as the live run used it.
 *
 * Mutation payloads are UNIONS: a Success member carrying the result and
 * a Failure member carrying `message` and `errors`. Every mutation
 * builder below selects `__typename`, the Success fragment, and the
 * Failure fragment's message; the rails unwrap Success payloads and
 * throw Failure payloads as errors with that message.
 *
 * The ContentItem API is EXPERIMENTAL — see src/drift for the watcher
 * that guards these shapes.
 */
import type {
  CreateDraftInput,
  CreatePostInput,
  PromoteInput,
  UpdateContentItemInput,
} from "./types";

function escapeGraphqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function gqlString(value: string): string {
  return `"${escapeGraphqlString(value)}"`;
}

export function gqlStringArray(values: string[]): string {
  return `[${values.map(gqlString).join(", ")}]`;
}

function gqlBoolean(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * Serialize an opaque JSON-shaped value (asset / metadata inputs whose
 * member shapes this agent does not model yet) as a GraphQL literal.
 * Strings are quoted and escaped; object keys are emitted bare, as
 * GraphQL input syntax requires.
 */
function gqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return gqlString(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return `[${value.map(gqlLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${gqlLiteral(v)}`);
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`Cannot serialize value as a GraphQL literal: ${String(value)}`);
}

export function buildCreateContentItemDraft(input: CreateDraftInput): string {
  const draftFields = [`text: ${gqlString(input.draft.text)}`];
  if (input.draft.assets?.length)
    draftFields.push(`assets: ${gqlLiteral(input.draft.assets)}`);
  if (input.draft.aiAssisted !== undefined)
    draftFields.push(`aiAssisted: ${gqlBoolean(input.draft.aiAssisted)}`);

  const fields = [
    `organizationId: ${gqlString(input.organizationId)}`,
    `draft: { ${draftFields.join(", ")} }`,
  ];
  if (input.title) fields.push(`title: ${gqlString(input.title)}`);
  if (input.tagIds?.length)
    fields.push(`tagIds: ${gqlStringArray(input.tagIds)}`);
  if (input.targetDate)
    fields.push(`targetDate: ${gqlString(input.targetDate)}`);
  if (input.correlationId)
    fields.push(`correlationId: ${gqlString(input.correlationId)}`);
  return `mutation {
    createContentItemDraft(input: { ${fields.join(", ")} }) {
      __typename
      ... on CreateContentItemDraftSuccess {
        contentItem {
          id
          title
          targetDate
          body { __typename ... on DraftContent { text } }
        }
      }
      ... on CreateContentItemDraftFailure { message }
    }
  }`;
}

function buildCreatePostInput(post: CreatePostInput): string {
  const fields = [
    `channelId: ${gqlString(post.channelId)}`,
    `mode: ${post.mode ?? "addToQueue"}`,
    `schedulingType: ${post.schedulingType ?? "automatic"}`,
    // Draft-first: a promoted Post lands as a draft unless a caller
    // explicitly opts out with saveToDraft: false.
    `saveToDraft: ${gqlBoolean(post.saveToDraft ?? true)}`,
  ];
  if (post.text !== undefined) fields.push(`text: ${gqlString(post.text)}`);
  if (post.assets?.length) fields.push(`assets: ${gqlLiteral(post.assets)}`);
  if (post.tagIds?.length)
    fields.push(`tagIds: ${gqlStringArray(post.tagIds)}`);
  if (post.dueAt) fields.push(`dueAt: ${gqlString(post.dueAt)}`);
  if (post.metadata) fields.push(`metadata: ${gqlLiteral(post.metadata)}`);
  return `{ ${fields.join(", ")} }`;
}

export function buildPromoteContentItemDraftToPosts(input: PromoteInput): string {
  const fields = [
    `id: ${gqlString(input.contentItemId)}`,
    `posts: [${input.posts.map(buildCreatePostInput).join(", ")}]`,
  ];
  if (input.tagIds?.length)
    fields.push(`tagIds: ${gqlStringArray(input.tagIds)}`);
  return `mutation {
    promoteContentItemDraftToPosts(input: { ${fields.join(", ")} }) {
      __typename
      ... on PromoteContentItemDraftToPostsSuccess {
        contentItem {
          id
          title
          targetDate
          body { __typename ... on PostContent { posts { id channel { id name } } } }
        }
      }
      ... on PromoteContentItemDraftToPostsFailure { message }
    }
  }`;
}

export function buildAddPostToContentItem(
  contentItemId: string,
  postId: string,
): string {
  // Payload union (live schema, re-verified 2026-10-31): Success | 
  // VoidMutationError. There is NO AddPostToContentItemFailure type and
  // the Success member carries no `message` field — the previous
  // document failed live GraphQL validation on both counts
  // (hackathon-2026-10-31 probe transcripts).
  return `mutation {
    addPostToContentItem(input: { id: ${gqlString(contentItemId)}, postId: ${gqlString(postId)} }) {
      __typename
      ... on AddPostToContentItemSuccess {
        contentItem { id body { __typename ... on PostContent { posts { id channel { id name } } } } }
        post { id contentItemId }
      }
      ... on VoidMutationError { message }
    }
  }`;
}

export function buildRemovePostFromContentItem(
  contentItemId: string,
  postId: string,
): string {
  // Same union shape as addPostToContentItem (Success | VoidMutationError);
  // see the note there. Fixed 2026-10-31 against the live schema.
  return `mutation {
    removePostFromContentItem(input: { id: ${gqlString(contentItemId)}, postId: ${gqlString(postId)} }) {
      __typename
      ... on RemovePostFromContentItemSuccess {
        contentItem { id }
        post { id contentItemId }
      }
      ... on VoidMutationError { message }
    }
  }`;
}

const POST_ACTION_ERROR_FRAGMENTS = `
      ... on InvalidInputError { message }
      ... on NotFoundError { message }
      ... on RestProxyError { message }
      ... on LimitReachedError { message }
      ... on UnauthorizedError { message }
      ... on UnexpectedError { message }`;

const POST_FULL_FIELDS = `id text status dueAt isCustomScheduled shareMode contentItemId channel { id name }`;

/** Read one Post in full (the scheduling path needs its current text). */
export function buildGetPostFull(postId: string): string {
  return `query {
    post(input: { id: ${gqlString(postId)} }) { ${POST_FULL_FIELDS} }
  }`;
}

/**
 * Create a standalone channel Post (the create half of the attachChannel
 * composition — createPost + addPostToContentItem, live-verified
 * 2026-10-31). Draft-first by default, like promotion.
 */
export function buildCreatePost(post: CreatePostInput): string {
  return `mutation {
    createPost(input: ${buildCreatePostInput(post)}) {
      __typename
      ... on PostActionSuccess { post { ${POST_FULL_FIELDS} } }
      ${POST_ACTION_ERROR_FRAGMENTS}
    }
  }`;
}

/**
 * Schedule an existing Post at an exact time — THE scheduling operation,
 * confirmed live 2026-10-31 (hackathon probe transcripts): editPost with
 * mode customScheduled + dueAt + saveToDraft false moves a draft Post to
 * status "scheduled". The caller MUST re-supply the post text: editPost
 * validates the whole post and rejects mode/dueAt changes without text
 * ("Invalid post: Post must have either text or media."). The queue
 * variant (mode addToQueue, same text requirement) and the revert
 * (saveToDraft: true -> back to draft) were confirmed in the same run.
 */
export function buildEditPostSchedule(input: {
  postId: string;
  text: string;
  scheduledAt: string;
}): string {
  return `mutation {
    editPost(input: { id: ${gqlString(input.postId)}, text: ${gqlString(input.text)}, mode: customScheduled, dueAt: ${gqlString(input.scheduledAt)}, saveToDraft: false }) {
      __typename
      ... on PostActionSuccess { post { ${POST_FULL_FIELDS} } }
      ${POST_ACTION_ERROR_FRAGMENTS}
    }
  }`;
}

export function buildGetPost(postId: string): string {
  return `query {
    post(input: { id: ${gqlString(postId)} }) { id contentItemId }
  }`;
}

export function buildGetContentItem(contentItemId: string): string {
  return `query {
    contentItem(input: { id: ${gqlString(contentItemId)} }) {
      id
      title
      targetDate
      body {
        __typename
        ... on DraftContent { text }
        ... on PostContent { posts { id channel { id name } } }
      }
    }
  }`;
}

export function buildUpdateContentItem(input: UpdateContentItemInput): string {
  // The live UpdateContentItemInput is exactly { id, title, targetDate }:
  // the API rejects tagIds as an unknown field (verified verbatim,
  // TEST-BATCH T2). Fail loudly HERE instead of shipping a document the
  // schema will reject, if a runtime caller passes it anyway.
  if ((input as unknown as Record<string, unknown>).tagIds !== undefined) {
    throw new Error(
      "updateContentItem does not accept tagIds: the live UpdateContentItemInput is { id, title, targetDate } only (verified 2026-10-24). Post-promotion tag mutation is not supported by the Buffer API.",
    );
  }
  const fields = [`id: ${gqlString(input.id)}`];
  if (input.title !== undefined) fields.push(`title: ${gqlString(input.title)}`);
  if (input.targetDate !== undefined)
    fields.push(`targetDate: ${gqlString(input.targetDate)}`);
  return `mutation {
    updateContentItem(input: { ${fields.join(", ")} }) {
      __typename
      ... on UpdateContentItemSuccess {
        contentItem {
          id
          title
          targetDate
        }
      }
      ... on UpdateContentItemFailure { message }
    }
  }`;
}

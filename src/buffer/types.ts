/**
 * Buffer GraphQL types used by this agent.
 *
 * The ContentItem API is EXPERIMENTAL: shapes may change
 * non-backwards-compatibly. The shapes below were corrected to the LIVE
 * schema on 2026-10-24 (authenticated introspection + live run via
 * Buffer's MCP advanced tools — see ~/workspace/buffer-project/
 * TEST-BATCH.md, results + schema-drift sections). They supersede the
 * guide-era shapes this file originally carried. The drift watcher
 * (src/drift) diffs the live surface against the pinned snapshot so the
 * next change is caught the same way.
 */

export interface BufferChannelRef {
  id: string;
  name?: string | null;
}

export interface BufferPostRef {
  id: string;
  /** Parent ContentItem ID, or null when the Post is not attached. */
  contentItemId: string | null;
  channel?: BufferChannelRef | null;
}

/**
 * A Post read in full (live shape, re-verified 2026-10-31). The
 * scheduling path needs `text`: editPost validates the whole post, so
 * scheduling re-supplies the current text (see queries.buildEditPostSchedule).
 */
export interface BufferPostFull extends BufferPostRef {
  text?: string | null;
  status?: string | null;
  dueAt?: string | null;
  isCustomScheduled?: boolean | null;
  shareMode?: string | null;
}

/** PostActionPayload union (createPost / editPost): PostActionSuccess
 * carrying `post`, or one of the *Error members carrying `message`. */
export interface PostActionPayload {
  __typename?: string;
  post?: BufferPostFull | null;
  message?: string | null;
}

export interface BufferContentItem {
  id: string;
  title?: string | null;
  targetDate?: string | null;
  body?: {
    __typename?: string;
    /** Present while the item is in DraftContent state. */
    text?: string | null;
    /** Present once the item is in PostContent state. */
    posts?: Array<{
      id: string;
      channel?: BufferChannelRef | null;
    }> | null;
  } | null;
}

export interface ContentItemRelationshipResult {
  contentItem?: BufferContentItem | null;
  post?: BufferPostRef | null;
  message?: string | null;
}

/**
 * The draft body of a createContentItemDraft call. In the live input the
 * content NESTS under `draft` (DraftContentInput) — there is no top-level
 * text field on CreateContentItemDraftInput.
 */
export interface DraftContentInput {
  /** Required by the live API (DraftContentInput.text is String!). */
  text: string;
  /**
   * Media assets. No flow in this agent passes assets yet, so the live
   * AssetInput member shape is carried opaquely and serialized as a
   * GraphQL literal by the builder.
   */
  assets?: Array<Record<string, unknown>>;
  aiAssisted?: boolean;
}

export interface CreateDraftInput {
  organizationId: string;
  draft: DraftContentInput;
  title?: string;
  tagIds?: string[];
  targetDate?: string;
  correlationId?: string;
}

export type ShareMode =
  | "addToQueue"
  | "customScheduled"
  | "shareNext"
  | "shareNow";

export type SchedulingType = "automatic" | "notification";

/**
 * One channel Post to create at promotion time (the live API's
 * CreatePostInput). mode and schedulingType are required by the API; the
 * builder defaults them to addToQueue / automatic when omitted.
 */
export interface CreatePostInput {
  channelId: string;
  mode?: ShareMode;
  schedulingType?: SchedulingType;
  /**
   * The builder emits `saveToDraft: true` when this is omitted — the
   * draft-first flow. Only an explicit false lets a promoted Post land
   * as anything other than a draft (and in this agent, scheduling still
   * sits behind the approval gate regardless).
   */
  saveToDraft?: boolean;
  /**
   * Post text. Effectively required in practice: the 2026-10-24 live run
   * (TEST-BATCH T1) showed promotion FAILS when no post text is supplied —
   * the draft body does not flow into the Post, the caller re-supplies it.
   */
  text?: string;
  assets?: Array<Record<string, unknown>>;
  tagIds?: string[];
  dueAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PromoteInput {
  contentItemId: string;
  /** One CreatePostInput per channel. The live input is posts[], NOT channelIds. */
  posts: CreatePostInput[];
  tagIds?: string[];
}

export interface UpdateContentItemInput {
  id: string;
  title?: string;
  targetDate?: string;
  /**
   * Deliberately NO tagIds: the live UpdateContentItemInput is exactly
   * { id, title, targetDate }. The 2026-10-24 live run (TEST-BATCH T2)
   * recorded the API rejecting tagIds verbatim as an unknown field —
   * post-promotion tag mutation is not supported. The builder in
   * queries.ts throws a loud local error if a runtime caller passes
   * tagIds anyway.
   */
}

/**
 * Union mutation payload as selected by the builders in queries.ts:
 * a Success member (carrying contentItem) or a Failure member (carrying
 * message and errors). Both rails unwrap this to the bare item, and
 * surface Failure payloads as thrown errors with their message.
 */
export interface ContentItemMutationPayload {
  __typename?: string;
  contentItem?: BufferContentItem | null;
  message?: string | null;
}

/** Union payload for the add/remove Post relationship mutations:
 * AddPostToContentItemSuccess / RemovePostFromContentItemSuccess
 * (contentItem + post, NO message field) or VoidMutationError (message).
 * Re-verified against the live schema 2026-10-31. */
export interface ContentItemRelationshipPayload {
  __typename?: string;
  contentItem?: BufferContentItem | null;
  post?: BufferPostRef | null;
  message?: string | null;
}

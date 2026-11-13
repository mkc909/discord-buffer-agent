/**
 * Discord REST helpers — used with the bot token for the parts of the flow
 * an interaction response can't do alone: editing the deferred follow-up
 * message, and opening a thread on it as the ContentItem's editorial room.
 *
 * Only official Bot API endpoints are used. No gateway connection, no
 * user-account automation (standing rule).
 */
import type { ActionRow } from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";

function authHeaders(botToken: string): Record<string, string> {
  return {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  };
}

/** Edit the deferred "@original" follow-up message of an interaction. */
export async function editOriginalResponse(
  botToken: string,
  applicationId: string,
  interactionToken: string,
  payload: { content: string; components?: ActionRow[] },
): Promise<{ id: string; channel_id: string }> {
  const res = await fetch(
    `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: authHeaders(botToken),
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Discord editOriginalResponse failed ${res.status}: ${(await res.text()).substring(0, 200)}`,
    );
  }
  return (await res.json()) as { id: string; channel_id: string };
}

/**
 * Start a public thread on a message — the thread becomes the item's
 * editorial room (one thread per ContentItem, AGENT-SCOPE.md).
 */
export async function startThreadOnMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  name: string,
): Promise<{ id: string }> {
  const res = await fetch(
    `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/threads`,
    {
      method: "POST",
      headers: authHeaders(botToken),
      body: JSON.stringify({ name: name.substring(0, 100) }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Discord startThread failed ${res.status}: ${(await res.text()).substring(0, 200)}`,
    );
  }
  return (await res.json()) as { id: string };
}

/** Post a plain follow-up message into a channel/thread (bot identity). */
export async function postToChannel(
  botToken: string,
  channelId: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: authHeaders(botToken),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(
      `Discord postToChannel failed ${res.status}: ${(await res.text()).substring(0, 200)}`,
    );
  }
}

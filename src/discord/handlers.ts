/**
 * Interaction handlers: slash commands + approval buttons.
 *
 * Every command defers (type 5) and completes through the follow-up
 * webhook, because real work (Buffer API, agent state) doesn't belong in
 * Discord's 3-second response window. Buttons answer synchronously where
 * the state operation is fast, and always reflect the agent's state —
 * the agent, not Discord, is where the approval gate lives.
 */
import { getAgentByName } from "agents";
import type { Env } from "../env";
import type { PublishingAgent, TrackedItem } from "../agent/publishing-agent";
import {
  ButtonStyle,
  ComponentType,
  EPHEMERAL,
  InteractionResponseType,
  buttonCustomId,
  parseButtonCustomId,
  type ActionRow,
  type Interaction,
  type InteractionResponse,
} from "./types";
import { editOriginalResponse, startThreadOnMessage } from "./rest";

function json(body: InteractionResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred(): Response {
  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

function ephemeral(content: string): Response {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  });
}

function option(interaction: Interaction, name: string): string | undefined {
  const opt = interaction.data?.options?.find((o) => o.name === name);
  return typeof opt?.value === "string" ? opt.value : undefined;
}

function invokingUserId(interaction: Interaction): string {
  return interaction.member?.user.id ?? interaction.user?.id ?? "unknown";
}

/** One durable agent per Discord guild (= one Buffer org in v1). */
async function agentStub(env: Env, name: string) {
  return getAgentByName(
    env.PUBLISHING_AGENT as unknown as DurableObjectNamespace<PublishingAgent>,
    name,
  );
}

export function formatItem(item: TrackedItem): string {
  const lines = [
    `**${item.title ?? "Untitled item"}** — \`${item.contentItemId}\``,
    `Phase: ${item.phase} · content v${item.contentVersion}` +
      (item.targetDate ? ` · target ${item.targetDate}` : ""),
  ];
  if (item.phase === "draft") {
    lines.push("No channel Posts yet — use /attach to add the first channel.");
  } else {
    for (const post of item.posts) {
      lines.push(`• ${post.channelName ?? post.channelId} — post \`${post.postId}\``);
    }
  }
  if (item.discordThreadId) lines.push(`Thread: <#${item.discordThreadId}>`);
  if (item.lastVerifiedAt) {
    lines.push(`Last verification (${item.lastVerifiedAt}): ${item.lastVerification ?? ""}`);
  }
  return lines.join("\n");
}

export function buttonsFor(item: TrackedItem): ActionRow[] {
  const buttons = [];
  if (item.phase === "post_content") {
    buttons.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: "Approve",
      custom_id: buttonCustomId("approve", item.contentItemId),
    });
  }
  if (item.phase === "approved") {
    buttons.push(
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.PRIMARY,
        label: "Schedule",
        custom_id: buttonCustomId("schedule", item.contentItemId),
      },
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.DANGER,
        label: "Revoke approval",
        custom_id: buttonCustomId("revoke", item.contentItemId),
      },
    );
  }
  buttons.push({
    type: ComponentType.BUTTON,
    style: ButtonStyle.SECONDARY,
    label: "Status",
    custom_id: buttonCustomId("status", item.contentItemId),
  });
  return [{ type: ComponentType.ACTION_ROW, components: buttons }];
}

// ---------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------

async function handleDraft(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const text = option(interaction, "text");
  if (!text) return ephemeral("`/draft` needs text.");
  ctx.waitUntil(
    (async () => {
      try {
        const agent = await agentStub(
          env,
          interaction.guild_id ? `guild:${interaction.guild_id}` : "dm",
        );
        const item = await agent.createDraft({
          text,
          createdBy: invokingUserId(interaction),
          title: option(interaction, "title"),
          targetDate: option(interaction, "target_date"),
        });
        const original = await editOriginalResponse(
          env.DISCORD_BOT_TOKEN,
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          {
            content: `Draft created in Buffer.\n${formatItem(item)}`,
            components: buttonsFor(item),
          },
        );
        // One thread per ContentItem: the item's editorial room.
        try {
          const thread = await startThreadOnMessage(
            env.DISCORD_BOT_TOKEN,
            original.channel_id,
            original.id,
            item.title ?? `Buffer draft ${item.contentItemId.slice(0, 8)}`,
          );
          await agent.registerThread({
            itemId: item.contentItemId,
            threadId: thread.id,
            messageId: original.id,
          });
        } catch (threadErr) {
          // Thread creation is best-effort in v1; the item still exists.
          console.error("thread creation failed", threadErr);
        }
      } catch (err) {
        await editOriginalResponse(
          env.DISCORD_BOT_TOKEN,
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          {
            content: `Draft failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ).catch(() => undefined);
      }
    })(),
  );
  return deferred();
}

async function handleAttach(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const channelId = option(interaction, "channel_id");
  if (!channelId) return ephemeral("`/attach` needs a Buffer channel_id.");
  ctx.waitUntil(
    (async () => {
      const fail = async (msg: string) =>
        editOriginalResponse(
          env.DISCORD_BOT_TOKEN,
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          { content: msg },
        ).catch(() => undefined);
      try {
        const agent = await agentStub(
          env,
          interaction.guild_id ? `guild:${interaction.guild_id}` : "dm",
        );
        let itemId = option(interaction, "item_id");
        if (!itemId && interaction.channel_id) {
          const inThread = await agent.findItemByThread(interaction.channel_id);
          itemId = inThread?.contentItemId;
        }
        if (!itemId) {
          await fail("Which item? Pass item_id, or run /attach inside the item's thread.");
          return;
        }
        const item = await agent.attachChannel({ itemId, channelId });
        await editOriginalResponse(
          env.DISCORD_BOT_TOKEN,
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          { content: `Channel attached.\n${formatItem(item)}`, components: buttonsFor(item) },
        );
      } catch (err) {
        await fail(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })(),
  );
  return deferred();
}

async function handleQueue(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  ctx.waitUntil(
    (async () => {
      try {
        const agent = await agentStub(
          env,
          interaction.guild_id ? `guild:${interaction.guild_id}` : "dm",
        );
        const queue = await agent.listQueue();
        const content = queue.length
          ? queue.map(formatItem).join("\n\n")
          : "Queue is empty — nothing awaiting approval or scheduled.";
        await editOriginalResponse(
          env.DISCORD_BOT_TOKEN,
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          { content: content.substring(0, 1900) },
        );
      } catch (err) {
        await editOriginalResponse(
          env.DISCORD_BOT_TOKEN,
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          { content: `Queue failed: ${err instanceof Error ? err.message : String(err)}` },
        ).catch(() => undefined);
      }
    })(),
  );
  return deferred();
}

async function handleApproveCommand(
  interaction: Interaction,
  env: Env,
): Promise<Response> {
  const itemId = option(interaction, "item_id");
  if (!itemId) return ephemeral("`/approve` needs an item_id.");
  try {
    const agent = await agentStub(
      env,
      interaction.guild_id ? `guild:${interaction.guild_id}` : "dm",
    );
    const record = await agent.approveItem({
      itemId,
      approvedBy: invokingUserId(interaction),
    });
    const item = (await agent.getStatus(itemId)) as TrackedItem;
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content:
          `Approved by <@${record.approvedBy}> for content v${record.contentVersion} ` +
          `(expires ${record.expiresAt}). Scheduling is now unlocked for this exact version.\n${formatItem(item)}`,
        components: buttonsFor(item),
      },
    });
  } catch (err) {
    return ephemeral(
      `Approval failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleStatusCommand(
  interaction: Interaction,
  env: Env,
): Promise<Response> {
  try {
    const agent = await agentStub(
      env,
      interaction.guild_id ? `guild:${interaction.guild_id}` : "dm",
    );
    const itemId = option(interaction, "item_id");
    const result = await agent.getStatus(itemId);
    const items = Array.isArray(result) ? result : [result];
    const content = items.length
      ? items.map(formatItem).join("\n\n")
      : "No tracked items yet — start with /draft.";
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: content.substring(0, 1900), flags: EPHEMERAL },
    });
  } catch (err) {
    return ephemeral(
      `Status failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------
// Buttons (message components)
// ---------------------------------------------------------------

async function handleComponent(
  interaction: Interaction,
  env: Env,
): Promise<Response> {
  const parsed = parseButtonCustomId(interaction.data?.custom_id ?? "");
  if (!parsed) return ephemeral("Unknown button.");
  const { action, itemId } = parsed;
  const agent = await agentStub(
    env,
    interaction.guild_id ? `guild:${interaction.guild_id}` : "dm",
  );

  try {
    if (action === "approve") {
      await agent.approveItem({ itemId, approvedBy: invokingUserId(interaction) });
      const item = (await agent.getStatus(itemId)) as TrackedItem;
      return json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `Approved by <@${invokingUserId(interaction)}>.\n${formatItem(item)}`,
          components: buttonsFor(item),
        },
      });
    }
    if (action === "revoke") {
      await agent.revokeApproval({ itemId });
      const item = (await agent.getStatus(itemId)) as TrackedItem;
      return json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `Approval revoked — scheduling is locked again.\n${formatItem(item)}`,
          components: buttonsFor(item),
        },
      });
    }
    if (action === "schedule") {
      const item = (await agent.getStatus(itemId)) as TrackedItem;
      const scheduledAt = item.targetDate
        ? `${item.targetDate}T09:00:00.000Z`
        : new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const updated = await agent.scheduleItem({ itemId, scheduledAt });
      return json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `Scheduled for ${scheduledAt}.\n${formatItem(updated)}`,
          components: buttonsFor(updated),
        },
      });
    }
    // action === "status"
    const item = (await agent.getStatus(itemId)) as TrackedItem;
    return ephemeral(formatItem(item));
  } catch (err) {
    // Gate refusals (ApprovalRequiredError) land here: surfaced to the
    // person who tapped, never swallowed, never bypassed.
    return ephemeral(
      `${action} refused: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------

export async function handleInteraction(
  interaction: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  switch (interaction.data?.name) {
    case "draft":
      return handleDraft(interaction, env, ctx);
    case "attach":
      return handleAttach(interaction, env, ctx);
    case "queue":
      return handleQueue(interaction, env, ctx);
    case "approve":
      return handleApproveCommand(interaction, env);
    case "status":
      return handleStatusCommand(interaction, env);
    default:
      break;
  }
  if (interaction.data?.custom_id) return handleComponent(interaction, env);
  return ephemeral("Unsupported interaction.");
}

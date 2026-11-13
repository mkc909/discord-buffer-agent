/**
 * The Discord interaction shapes this Worker handles (subset of the
 * Discord API types — only what the command surface uses).
 */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

/** Message flag: only the invoking user sees the message. */
export const EPHEMERAL = 64;

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
} as const;

export const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
} as const;

export interface DiscordUser {
  id: string;
  username: string;
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    options?: CommandOption[];
  };
  message?: { id: string };
}

export interface ButtonComponent {
  type: typeof ComponentType.BUTTON;
  style: number;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: typeof ComponentType.ACTION_ROW;
  components: ButtonComponent[];
}

export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    components?: ActionRow[];
  };
}

/** Button custom_id scheme: "<action>:<contentItemId>". */
export type ButtonAction = "approve" | "schedule" | "revoke" | "status";

export function buttonCustomId(action: ButtonAction, itemId: string): string {
  return `${action}:${itemId}`;
}

export function parseButtonCustomId(
  customId: string,
): { action: ButtonAction; itemId: string } | null {
  const sep = customId.indexOf(":");
  if (sep < 0) return null;
  const action = customId.slice(0, sep) as ButtonAction;
  if (!["approve", "schedule", "revoke", "status"].includes(action)) {
    return null;
  }
  return { action, itemId: customId.slice(sep + 1) };
}

/**
 * Slash command definitions. Registered with Discord by
 * scripts/register-commands.mjs; handled in handlers.ts.
 */
export const COMMANDS = [
  {
    name: "draft",
    description: "Create a Buffer ContentItem draft and open its editorial thread",
    type: 1,
    options: [
      {
        name: "text",
        description: "Draft text (the source content — Publisher OS stays canonical)",
        type: 3, // STRING
        required: true,
      },
      {
        name: "title",
        description: "Optional title for the item",
        type: 3,
        required: false,
      },
      {
        name: "target_date",
        description: "Optional ISO target date (YYYY-MM-DD)",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "attach",
    description: "Attach a Buffer channel to the item (first channel promotes the draft)",
    type: 1,
    options: [
      {
        name: "channel_id",
        description: "Buffer channel ID to attach",
        type: 3,
        required: true,
      },
      {
        name: "item_id",
        description: "ContentItem ID (defaults to this thread's item, else your latest)",
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: "queue",
    description: "Show items awaiting approval, approved, or scheduled across channels",
    type: 1,
    options: [],
  },
  {
    name: "approve",
    description: "Approve an item for scheduling (human approval gate — nothing schedules without this)",
    type: 1,
    options: [
      {
        name: "item_id",
        description: "ContentItem ID to approve",
        type: 3,
        required: true,
      },
    ],
  },
  {
    name: "status",
    description: "Item state: draft/posts per channel, approval, last verification",
    type: 1,
    options: [
      {
        name: "item_id",
        description: "ContentItem ID (omit to list all tracked items)",
        type: 3,
        required: false,
      },
    ],
  },
] as const;

/**
 * Register the slash commands with Discord (guild-scoped when DISCORD_GUILD_ID
 * is set — instant propagation, right for development; global otherwise).
 *
 * Usage:
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register-commands
 * Values come from YOUR shell environment only. Never commit them.
 */
import { COMMANDS } from "../src/discord/commands.ts";

const appId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !botToken) {
  console.error(
    "Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in your shell environment first.",
  );
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`Registration failed ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const registered = await res.json();
console.log(
  `Registered ${registered.length} commands ${guildId ? `in guild ${guildId}` : "globally"}.`,
);

# Discord Bedrock Server Bot

A Discord bot that monitors a Minecraft Bedrock server hosted on Kinetic Hosting.

This bot is designed for Minecraft Bedrock servers hosted on Kinetic Hosting. It relies on Kinetic's API and websocket console access, and does not support Java Edition or alternative control panels such as Apex, Pebble, or Pterodactyl.

## Features

- Console relay: streams Kinetic Panel console output into a Discord text channel using fenced code blocks.
- Join/leave logging: detects player connect/disconnect events from console output and sends rich embeds.
- Player status channel: periodically pings the Bedrock server and updates a channel name with online/offline status and player count.
- Day counter channel: queries the world day from the server and updates a configured voice channel name like `Day 123`.
- `/list` slash command: lists currently online players.
- `/allowlist` slash command: admin-only command that sends `allowlist add <username>` to the server console.
- `/worldinfo` slash command: reports server status, player count, time of day, current day, and weather.
- Basic chat helpers: supports `/help` text commands for quick diagnostics.

## Setup

1. Set up your Kinetic Panel host.
   - Create or log in to your Kinetic Panel account.
   - Go to your Minecraft Bedrock Dedicated server.
   - Go to 'Settings' then 'Server Details' to find the server ID for the target instance and put it into `KINETIC_SERVER_ID`.
   - Go to the API credentials section and create an API key to put into `KINETIC_API_KEY`.

2. Create a Discord bot at https://discord.com/developers/applications.
   - Copy the bot token into `DISCORD_TOKEN`.
   - Copy the application client ID into `CLIENT_ID`.
   - Add your server/guild ID to `GUILD_ID`.

3. Enable the bot gateway intents:
   - `Server Members Intent` is not required for basic features, but you may need it if you use role-based admin permissions.
   - Ensure the bot can read messages and send messages in the configured channels.

4. Invite the bot to your Discord server.
   - Use the OAuth2 URL generator in the Discord Developer Portal.
   - Grant at least these permissions:
     - `Manage Channels`
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Read Message History`
   - The bot needs channel rename permissions so it can update the player count and day counter channels.

5. Configure the environment file.
   - Copy `.env.example` to `.env`.
   - Fill in your Discord and Kinetic Panel values, as well as the Discord channel IDs.
   - Any feature without a configured channel ID is automatically disabled.
   - Only the channels you want to use need to be configured.

6. Set any optional flags.
   - `JOIN_LOG_SHOW_PLAYER_COUNT`, `JOIN_LOG_SHOW_ONLINE_PLAYERS`, `LEAVE_LOG_SHOW_PLAYER_COUNT`, and `LEAVE_LOG_SHOW_ONLINE_PLAYERS` can be `true` or `false`.
   - `DAY_COUNTER_INTERVAL_MINUTES` controls how often the bot refreshes the world day channel name.

7. Install dependencies and start the bot:
   ```bash
   git clone <repository-url>
   cd discord-bedrock-server-bot
   npm install
   cp .env.example .env
   node discord-bot.js
   ```

8. Verify slash commands in your Discord server.
   - The bot registers `/list`, `/allowlist`, and `/worldinfo` on startup.
   - Slash commands may take a few seconds to appear after the bot starts.
   - `allowlist` is restricted to users with IDs or roles configured through `ADMIN_USERS` and `ADMIN_ROLE_IDS`.

## Requirements

- Node.js 18.x or newer.
- A Kinetic Panel-hosted Minecraft Bedrock server with websocket console access.
- A Discord bot application and the required channel permissions.
- Java Edition is not supported.

## Environment Variables

- `KINETIC_API_BASE_URL` - Base URL for the Kinetic Panel API.
- `KINETIC_API_KEY` - API key for Kinetic.
- `KINETIC_SERVER_ID` - Kinetic server ID for websocket auth.
- `DISCORD_TOKEN` - Discord bot token.
- `CLIENT_ID` - Discord application client ID.
- `GUILD_ID` - Guild ID for registering slash commands.
- `SERVER_IP` - Game server IP for Bedrock ping.
- `SERVER_PORT` - Game server port.
- `PLAYER_COUNT_CHANNEL_ID` - Channel name updated with current player count.
- `CONSOLE_CHANNEL_ID` - Channel used for console relay output.
- `JOIN_LOG_CHANNEL_ID` - Channel used for join notifications.
- `LEAVE_LOG_CHANNEL_ID` - Channel used for leave notifications.
- `JOIN_LOG_SHOW_PLAYER_COUNT` - If `true`, include player count in join embeds.
- `JOIN_LOG_SHOW_ONLINE_PLAYERS` - If `true`, include online player list in join embeds.
- `LEAVE_LOG_SHOW_PLAYER_COUNT` - If `true`, include player count in leave embeds.
- `LEAVE_LOG_SHOW_ONLINE_PLAYERS` - If `true`, include online player list in leave embeds.
- `ADMIN_USERS` - Comma-separated Discord user IDs allowed to use admin commands.
- `ADMIN_ROLE_IDS` - Comma-separated role IDs allowed to use admin commands.
- `DAY_COUNTER_CHANNEL_ID` - Voice channel ID to update with the current world day.
- `DAY_COUNTER_INTERVAL_MINUTES` - Minutes between day counter updates.

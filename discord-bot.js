require("dotenv").config();

const axios = require("axios");
const dgram = require("dgram");
const WebSocket = require("ws");
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// Discord bot client used for events, channel fetches, and message delivery.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// REST client used for registering slash commands with the Discord API.
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

// Remove ANSI color codes from console text before parsing.
function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDiscordRateLimitError(error) {
  return (
    error &&
    (error.status === 429 || error.code === 20028 || /rate limit/i.test(String(error.message)))
  );
}

async function safeDiscordAction(actionDescription, callback, retries = 1) {
  try {
    return await callback();
  } catch (error) {
    if (isDiscordRateLimitError(error) && retries > 0) {
      const retryAfter = error.retryAfter ?? error.timeout ?? null;
      const waitMs = retryAfter ? Math.ceil(retryAfter + 100) : 1000;
      console.warn(
        `[Discord Rate Limit] ${actionDescription} blocked. Waiting ${waitMs}ms before retrying.`
      );
      await delay(waitMs);
      return safeDiscordAction(actionDescription, callback, retries - 1);
    }

    if (isDiscordRateLimitError(error)) {
      const retryAfter = error.retryAfter ?? error.timeout ?? null;
      console.error(
        `[Discord Rate Limit] ${actionDescription} failed after retries. Retry after: ${retryAfter ?? "unknown"}ms`
      );
    }

    throw error;
  }
}

async function safeChannelSend(channel, payload) {
  return safeDiscordAction(`send to channel ${channel.id}`, () => channel.send(payload));
}

async function safeChannelSetName(channel, name) {
  return safeDiscordAction(`rename channel ${channel.id} to ${name}`, () => channel.setName(name));
}

async function safeInteractionEditReply(interaction, payload) {
  return safeDiscordAction(`editReply ${interaction.id ?? interaction.user.id}`, () => interaction.editReply(payload));
}

async function safeInteractionReply(interaction, payload) {
  return safeDiscordAction(`reply ${interaction.id ?? interaction.user.id}`, () => interaction.reply(payload));
}

const consoleMessageQueue = [];
let consoleMessageFlushTimer = null;
const CONSOLE_MESSAGE_MAX_LINES = 20;
const CONSOLE_FLUSH_INTERVAL_MS = 1000;

function scheduleConsoleFlush() {
  if (consoleMessageFlushTimer) return;
  consoleMessageFlushTimer = setTimeout(async () => {
    consoleMessageFlushTimer = null;
    const lines = consoleMessageQueue.splice(0, consoleMessageQueue.length);
    if (!lines.length) return;

    const content = `\`\`\`${lines.join("\n")}\`\`\``;
    try {
      const channel = await getConsoleChannel();
      if (channel) {
        await safeChannelSend(channel, content);
      }
    } catch (error) {
      console.error("Failed to flush console relay messages:", error.message || error);
    }
  }, CONSOLE_FLUSH_INTERVAL_MS);
}

function queueConsoleMessage(text) {
  const escaped = String(text).replace(/```/g, "`\`\`\`");
  consoleMessageQueue.push(escaped);
  if (consoleMessageQueue.length > CONSOLE_MESSAGE_MAX_LINES) {
    consoleMessageQueue.splice(0, consoleMessageQueue.length - CONSOLE_MESSAGE_MAX_LINES);
  }
  scheduleConsoleFlush();
}

// Parse the Bedrock server "list" console output and return player counts and usernames.
function parseListResponse(lines) {
  let count = null;
  let total = null;
  let waitingForPlayerList = false;
  let usernames = [];

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;

    const headerMatch = line.match(/There are\s+(\d+)\s*\/\s*(\d+)\s+players?\s+online\s*:\s*(.*)$/i);
    if (headerMatch) {
      waitingForPlayerList = true;
      count = Number(headerMatch[1]);
      total = Number(headerMatch[2]);
      const trailing = headerMatch[3].trim();

      if (trailing) {
        usernames = extractNames(trailing);
        return {
          count,
          total,
          usernames: [...new Set(usernames)],
          done: true,
        };
      }

      if (count === 0) {
        return {
          count,
          total,
          usernames: [],
          done: true,
        };
      }

      continue;
    }

    if (!waitingForPlayerList) {
      continue;
    }

    const names = extractNames(line);
    if (names.length) {
      usernames = names;
      return {
        count,
        total,
        usernames: [...new Set(usernames)],
        done: true,
      };
    }
  }

  return {
    count,
    total,
    usernames: [...new Set(usernames)],
    done: false,
  };
}

// Extract player names from a server response line and filter invalid tokens.
function extractNames(value) {
  const cleaned = String(value).replace(/^[-•*]\s*/, "").trim();
  if (!cleaned) return [];

  const candidates = cleaned.includes(",")
    ? cleaned.split(/,\s*/)
    : cleaned.split(/\s+/);

  return candidates
    .map((name) => name.trim())
    .filter((name) => name && /^[A-Za-z0-9_.-]+$/.test(name));
}

// Format an offline duration into a human-readable label.
function getOfflineDurationLabel(startTime) {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  if (seconds < 60) {
    return `0m ${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const secs = seconds - minutes * 60;
    return `${minutes}m ${secs}s`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const mins = minutes - hours * 60;
    return `${hours}h ${mins}m`;
  }

  const days = Math.floor(hours / 24);
  const hrs = hours - days * 24;
  return `${days}d ${hrs}h`;
}

// Resolve the configured console relay channel from environment and return it if valid.
async function getConsoleChannel() {
  const channelId = process.env.CONSOLE_CHANNEL_ID;
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId);
    return channel && channel.isTextBased && channel.guild ? channel : null;
  } catch (error) {
    console.error("Failed to fetch console channel:", error.message);
    return null;
  }
}

// Send a fenced code block message to the console relay channel.
async function logConsoleChannelMessage(text) {
  queueConsoleMessage(text);
}

// Detect player connect/disconnect events from server console lines.
function parsePlayerEvent(line) {
  const match = line.match(/Player\s+(connected|disconnected)\s*:\s*(.+)$/i);
  if (!match) return null;

  const username = match[2]
    .replace(/\s*,\s*xuid:\s*[^,]+/gi, "")
    .replace(/\s*,\s*pfid:\s*[A-Za-z0-9]+/gi, "")
    .trim();

  if (!username) return null;

  return {
    type: match[1].toLowerCase(),
    username,
  };
}

// Interpret common truthy environment values such as true, 1, yes, or y.
function isEnvEnabled(key) {
  const value = (process.env[key] || "").toLowerCase().trim();
  return value === "true" || value === "1" || value === "yes" || value === "y";
}

// Fetch a Discord channel by primary and fallback environment variables.
async function getChannelByEnv(envVar, fallbackVar) {
  const channelId = process.env[envVar] || process.env[fallbackVar];
  if (!channelId) return null;

  try {
    const channel = await client.channels.fetch(channelId);
    return channel && channel.isTextBased && channel.guild ? channel : null;
  } catch (error) {
    console.error(`Failed to fetch channel for ${envVar}:`, error.message);
    return null;
  }
}

// Build and send a join/leave embed to the configured log channel.
async function sendPlayerEventEmbed(eventInfo) {
  const isJoin = eventInfo.type === "connected";
  const channel = await getChannelByEnv(
    isJoin ? "JOIN_LOG_CHANNEL_ID" : "LEAVE_LOG_CHANNEL_ID",
    "JOIN_LEAVE_LOG_CHANNEL_ID"
  );
  if (!channel) return;

  const showCount = isEnvEnabled(isJoin ? "JOIN_LOG_SHOW_PLAYER_COUNT" : "LEAVE_LOG_SHOW_PLAYER_COUNT");
  const showList = isEnvEnabled(isJoin ? "JOIN_LOG_SHOW_ONLINE_PLAYERS" : "LEAVE_LOG_SHOW_ONLINE_PLAYERS");

  const shouldFetchList = showCount || showList || !!process.env.PLAYER_COUNT_CHANNEL_ID;
  let listResult = { count: null, total: null, usernames: [] };
  if (shouldFetchList) {
    try {
      listResult = await requestPlayerList();
    } catch (error) {
      console.warn("Failed to fetch player list on join/leave event, falling back to UDP ping if available:", error.message);
      const host = process.env.SERVER_IP;
      const port = Number(process.env.SERVER_PORT || 25565);
      if (host) {
        try {
          const pingResult = await pingServer(host, port, 3000);
          if (pingResult.online && typeof pingResult.count === "number" && typeof pingResult.total === "number") {
            listResult = { count: pingResult.count, total: pingResult.total, usernames: [] };
          }
        } catch {
          listResult = { count: null, total: null, usernames: [] };
        }
      }
    }
  }

  const playerCountText = typeof listResult.count === "number" && typeof listResult.total === "number"
    ? `${listResult.count}/${listResult.total} Players`
    : "Unknown players";

  const embed = new EmbedBuilder()
    .setTitle(isJoin ? "Player Joined" : "Player Left")
    .setDescription(`**${eventInfo.username}** ${isJoin ? "joined" : "left"} the server!`)
    .setTimestamp();

  if (showCount) {
    embed.addFields({
      name: "New Player Count",
      value: playerCountText,
      inline: false,
    });
  }

  if (showList) {
    const players = listResult.usernames.length
      ? listResult.usernames.map((name) => `- ${name}`).join("\n")
      : "No players online.";

    embed.addFields({
      name: "Online Players",
      value: players,
      inline: false,
    });
  }

  try {
    await safeChannelSend(channel, { embeds: [embed] });
  } catch (error) {
    console.error("Failed to send join/leave embed:", error.message);
  }

  if (process.env.PLAYER_COUNT_CHANNEL_ID) {
    updatePlayerCountChannel(listResult).catch((error) => console.error("Failed to update player count channel:", error.message));
  }
}

// Start a websocket connection to the Kinetic server and relay console output to Discord.
async function startConsoleRelay() {
  console.log("🔌 Starting console relay...");

  try {
    const creds = await getWebsocketCredentials();
    const ws = new WebSocket(creds.socket, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Origin: "https://kineticpanel.net",
        "User-Agent": "Mozilla/5.0",
      },
    });

    ws.on("open", async () => {
      ws.send(JSON.stringify({ event: "auth", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "authenticate", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "token", args: [creds.token] }));
      await logConsoleChannelMessage("✅ Console relay connected.");
    });

    ws.on("message", async (msg) => {
      let packet;
      try {
        packet = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (packet.event !== "console output") {
        return;
      }

      for (const line of packet.args ?? []) {
        const cleanedLine = stripAnsi(line);
        if (!cleanedLine) continue;

        const eventInfo = parsePlayerEvent(cleanedLine);
        if (eventInfo) {
          sendPlayerEventEmbed(eventInfo).catch((error) => console.error(error));
        }

        await logConsoleChannelMessage(`[CONSOLE] ${cleanedLine}`);
      }
    });

    ws.on("close", (_code, _reason) => {
      logConsoleChannelMessage("⚠️ Console relay disconnected. Reconnecting in 5 seconds...");
      setTimeout(startConsoleRelay, 5000);
    });

    ws.on("error", (error) => {
      console.error("Console relay error:", error.message);
    });
  } catch (error) {
    console.error("Failed to start console relay:", error.message);
    setTimeout(startConsoleRelay, 5000);
  }
}

async function getConsoleChannel() {
  const channelId = process.env.CONSOLE_CHANNEL_ID;
  if (!channelId) {
    console.error("CONSOLE_CHANNEL_ID is not set in .env");
    return null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    return channel && channel.isTextBased && channel.guild ? channel : null;
  } catch (error) {
    console.error("Failed to fetch console channel:", error.message);
    return null;
  }
}

// Send a Bedrock UDP ping and parse the server's status response.
async function pingServer(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let finished = false;

    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };

    const timer = setTimeout(() => done({ online: false, count: null, total: null, err: new Error("timeout") }), timeout);

    const payload = Buffer.alloc(1 + 8 + 16 + 8);
    payload.writeUInt8(0x01, 0);
    payload.writeBigInt64BE(BigInt(Date.now()), 1);
    Buffer.from([0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]).copy(payload, 9);
    payload.writeBigUInt64BE(BigInt(Date.now()), 25);

    socket.on("message", (message) => {
      try {
        if (message.length < 35 || message.readUInt8(0) !== 0x1c) {
          return done({ online: false, count: null, total: null, err: new Error("invalid response") });
        }

        const magic = message.slice(17, 33);
        const expectedMagic = Buffer.from([0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]);
        if (!magic.equals(expectedMagic)) {
          return done({ online: false, count: null, total: null, err: new Error("invalid magic") });
        }

        let payload = "";
        if (message.length >= 35) {
          const stringLen = message.readUInt16LE(33);
          const stringStart = 35;
          if (message.length >= stringStart + stringLen) {
            payload = message.slice(stringStart, stringStart + stringLen).toString("utf8");
          } else {
            payload = message.slice(33).toString("utf8");
          }
        }

        payload = payload.replace(/\x00/g, "");
        const parts = payload.split(";");
        const count = parts.length > 4 ? Number(parts[4]) : null;
        const total = parts.length > 5 ? Number(parts[5]) : null;

        return done({ online: true, count: Number.isFinite(count) ? count : null, total: Number.isFinite(total) ? total : null, err: null });
      } catch (error) {
        return done({ online: false, count: null, total: null, err: error });
      }
    });

    socket.on("error", (error) => done({ online: false, count: null, total: null, err: error }));

    socket.send(payload, port, host, (error) => {
      if (error) {
        done({ online: false, count: null, total: null, err: error });
      }
    });
  });
}

// Rename the configured server status channel with the latest online/offline state.
async function updateStatusChannel(name) {
  const channelId = process.env.SERVER_STATUS_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.guild) return;
    await safeChannelSetName(channel, name);
  } catch (error) {
    console.error("Failed to update status channel name:", error.message);
  }
}

async function updatePlayerCountChannel(listResult) {
  const channelId = process.env.PLAYER_COUNT_CHANNEL_ID;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.guild) return;

    const countName = typeof listResult.count === "number" && typeof listResult.total === "number"
      ? `${listResult.count}/${listResult.total} Players`
      : "Players: Unknown";

    if (channel.name !== countName) {
      await safeChannelSetName(channel, countName);
    }
  } catch (error) {
    console.error("Failed to update player count channel name:", error.message);
  }
}

// Periodically refresh server status and update the status channel name.
async function refreshServerStatus() {
  const host = process.env.SERVER_IP;
  const port = Number(process.env.SERVER_PORT || 25565);
  if (!host) return;

  const statusChannelId = process.env.SERVER_STATUS_CHANNEL_ID || process.env.PLAYER_COUNT_CHANNEL_ID;
  if (!statusChannelId) return;

  const startOffline = refreshServerStatus.offlineSince ?? null;

  const pingResult = await pingServer(host, port, 3000);
  if (pingResult.online) {
    refreshServerStatus.offlineSince = null;
    await updateStatusChannel("🟢 Online");
    return;
  }

  // UDP ping failed, fall back to a Kinetic `list` command to verify server reachability.
  try {
    const listResult = await requestPlayerList();
    refreshServerStatus.offlineSince = null;
    await updateStatusChannel("🟢 Online");
    await updatePlayerCountChannel(listResult).catch((error) => console.error("Failed to update player count channel after fallback list:", error.message));
    return;
  } catch (fallbackError) {
    console.warn("UDP ping failed and fallback list command did not confirm server online:", fallbackError.message || fallbackError);
  }

  if (!startOffline) {
    refreshServerStatus.offlineSince = Date.now();
  }

  const offlineLabel = getOfflineDurationLabel(refreshServerStatus.offlineSince);
  await updateStatusChannel(`🔴 Offline: ${offlineLabel}`);
}

// Query the server day counter and update the configured voice channel name.
async function updateDayCounterChannel() {
  const channelId = process.env.DAY_COUNTER_CHANNEL_ID;
  if (!channelId) return;

  try {
    const lines = await requestConsoleResponse("time query day", /Day\s+is\s*(\d+)/i, 4000);
    const joined = (lines || []).join(" ");
    const m = joined.match(/Day\s+is\s*(\d+)/i);
    if (!m) return;
    const dayNumber = Number(m[1]);
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.guild) {
      const newName = `Day ${dayNumber}`;
      if (channel.name !== newName) {
        await safeChannelSetName(channel, newName);
        console.log(`Updated day counter channel to: ${newName}`);
      }
    }
  } catch (err) {
    console.error("Failed to update day counter channel:", err.message || err);
  }
}

// Schedule regular day counter checks and channel updates.
async function startDayCounterUpdater() {
  const minutes = Number(process.env.DAY_COUNTER_INTERVAL_MINUTES || 5);
  const ms = Math.max(1000, Math.floor(minutes) * 60 * 1000);

  await updateDayCounterChannel();

  setInterval(() => {
    updateDayCounterChannel().catch((err) => console.error("day counter update failed:", err.message || err));
  }, ms);

  return Promise.resolve();
}

// Request temporary websocket credentials from the Kinetic API.
async function getWebsocketCredentials() {
  const apiBase = process.env.KINETIC_API_BASE_URL || "https://kineticpanel.net";
  const token = process.env.KINETIC_API_KEY;
  const serverId = process.env.KINETIC_SERVER_ID;

  if (!token || !serverId) {
    throw new Error("Missing KINETIC_API_KEY or KINETIC_SERVER_ID");
  }

  const response = await axios.get(`${apiBase}/api/client/servers/${serverId}/websocket`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const data = response.data.data || response.data;

  return {
    socket: data.socket || data.websocket || data.url,
    token: data.token || data.jwt || data.auth,
  };
}

// Parse comma/semicolon/whitespace separated IDs from an environment variable.
function parseCsvIds(key) {
  return (process.env[key] || "")
    .split(/[;,\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

// Send a single console command to the Kinetic websocket without waiting for output.
async function sendConsoleCommand(command) {
  const creds = await getWebsocketCredentials();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(creds.socket, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Origin: "https://kineticpanel.net",
        "User-Agent": "Mozilla/5.0",
      },
    });

    let finished = false;
    const cleanup = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {}
      }
      ws.removeAllListeners();
    };

    const done = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      cleanup();
      if (err) return reject(err);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      done(new Error("Timed out sending console command."));
    }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "auth", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "authenticate", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "token", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "send command", args: [command] }));
      done(null, { command });
    });

    ws.on("error", (error) => done(error));
  });
}

async function requestConsoleResponse(command, matchRegex, timeout = 5000) {
  const creds = await getWebsocketCredentials();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(creds.socket, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Origin: "https://kineticpanel.net",
        "User-Agent": "Mozilla/5.0",
      },
    });

    let settled = false;
    const collected = [];

    const cleanup = () => {
      try {
        ws.removeAllListeners();
      } catch {}
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {}
    };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (err) return reject(err);
      resolve(result);
    };

    const timer = setTimeout(() => finish(new Error("Timed out waiting for console response")), timeout);

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "auth", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "authenticate", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "token", args: [creds.token] }));

      setTimeout(() => {
        ws.send(JSON.stringify({ event: "send command", args: [command] }));
      }, 250);
    });

    ws.on("message", (msg) => {
      let packet;
      try {
        packet = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (packet.event !== "console output") return;

      for (const line of packet.args ?? []) {
        const cleaned = stripAnsi(line);
        if (!cleaned) continue;
        collected.push(cleaned);

        if (matchRegex) {
          for (const l of collected) {
            if (matchRegex.test(l)) {
              return finish(null, collected);
            }
          }
        }
      }
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish(new Error("console websocket closed before response")));
  });
}

function ticksToTime(ticks) {
  const t = ((ticks % 24000) + 24000) % 24000;
  const totalMinutes = Math.floor((t / 1000) * 60) + 6 * 60;
  const hours = Math.floor((totalMinutes / 60) % 24);
  const minutes = totalMinutes % 60;
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Convert Bedrock tick count into a textual time-of-day label.
function ticksToPhase(ticks) {
  const t = ((ticks % 24000) + 24000) % 24000;
  if (t < 1000) return "Sunrise";
  if (t < 6000) return "Morning";
  if (t < 12000) return "Noon";
  if (t < 13000) return "Sunset";
  if (t < 18000) return "Evening";
  if (t < 23000) return "Midnight";
  return "Dawn";
}

// Validate whether the interaction user is an admin by role, user ID, or guild ownership.
async function isInteractionAdmin(interaction) {
  if (!interaction.guild) return false;

  const authorId = interaction.user.id;
  if (authorId === interaction.guild.ownerId) return true;

  const adminUsers = parseCsvIds("ADMIN_USERS");
  if (adminUsers.includes(authorId)) return true;

  const adminRoles = parseCsvIds("ADMIN_ROLE_IDS");
  if (adminRoles.length === 0) return false;

  let member = interaction.member;
  if (!member || typeof member === "string") {
    try {
      member = await interaction.guild.members.fetch(authorId);
    } catch {
      return false;
    }
  }

  if (member.roles) {
    return member.roles.cache.some((role) => adminRoles.includes(role.id));
  }

  return false;
}

// Request the server player list by sending the Bedrock "list" command over the Kinetic websocket.
async function requestPlayerList() {
  const creds = await getWebsocketCredentials();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(creds.socket, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Origin: "https://kineticpanel.net",
        "User-Agent": "Mozilla/5.0",
      },
    });

    let settled = false;
    const collectedLines = [];

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try {
        ws.removeAllListeners();
      } catch {}
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {}
      }
      if (err) return reject(err);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish(new Error("Timed out waiting for the server list response."));
    }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "auth", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "authenticate", args: [creds.token] }));
      ws.send(JSON.stringify({ event: "token", args: [creds.token] }));

      setTimeout(() => {
        ws.send(JSON.stringify({ event: "send command", args: ["list"] }));
      }, 1000);
    });

    ws.on("message", (msg) => {
      let packet;

      try {
        packet = JSON.parse(msg.toString());
      } catch {
        return;
      }

      if (packet.event !== "console output") {
        return;
      }

      for (const line of packet.args ?? []) {
        const cleanedLine = stripAnsi(line);
        if (!cleanedLine) continue;

        collectedLines.push(cleanedLine);
        const parsed = parseListResponse(collectedLines);

        if (parsed.done) {
          finish(null, parsed);
          return;
        }
      }
    });

    ws.on("error", (error) => {
      finish(new Error(error.message || "WebSocket error"));
    });

    ws.on("close", (code, reason) => {
      if (!settled) {
        finish(new Error(`Connection closed: ${code} ${reason.toString()}`));
      }
    });
  });
}

// Register slash commands with Discord for this bot.
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show a list of bot commands and what they do."),
    new SlashCommandBuilder()
      .setName("list")
      .setDescription("List the players currently online on the game server"),
    new SlashCommandBuilder()
      .setName("allowlist")
      .setDescription("Add a player to the server allowlist")
      .addStringOption((option) =>
        option
          .setName("username")
          .setDescription("Player username to allowlist")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("worldinfo")
      .setDescription("Show current world information: status, time, day, players"),
  ].map((command) => command.toJSON());

  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!clientId) {
    throw new Error("Missing CLIENT_ID for slash command registration");
  }

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
}

// Bot startup entrypoint: register commands, start status updates, day counter updates, and console relay.
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot ready as ${readyClient.user.tag}`);

  try {
    await registerSlashCommands();
    console.log("✅ Slash command registered");
  } catch (error) {
    console.error("Slash command registration failed:", error.message);
  }

  refreshServerStatus()
    .then(() => console.log("✅ Server status updater started"))
    .catch((error) => console.error("Server status updater failed:", error.message));

  setInterval(refreshServerStatus, 60000);

  startDayCounterUpdater()
    .then(() => console.log("✅ Day counter updater started"))
    .catch((err) => console.error("Day counter updater failed:", err.message));

  startConsoleRelay()
    .then(() => console.log("✅ Console relay started"))
    .catch((error) => console.error("Console relay failed to start:", error.message));
});

// Handle simple text commands in chat for diagnostics and help.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
});

// Handle slash command interactions from Discord.
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "help") {
    await interaction.deferReply();

    const helpEmbed = new EmbedBuilder()
      .setTitle("Bot Help")
      .setDescription("Available slash commands and their descriptions.")
      .addFields(
        { name: "/help", value: "Show this help menu.", inline: false },
        { name: "/list", value: "Fetch a current player list from the Bedrock server.", inline: false },
        { name: "/worldinfo", value: "Show server status, player count, time, day, and weather.", inline: false },
        { name: "/allowlist", value: "Admin-only command to add a player to the server allowlist.", inline: false }
      )
      .setTimestamp()
      .setFooter({ text: `Requested by ${interaction.user.tag}` });

    await safeInteractionEditReply(interaction, { embeds: [helpEmbed] });
    return;
  }

  if (interaction.commandName === "list") {
    await interaction.deferReply();

    try {
      const result = await requestPlayerList();
      const playerList = result.usernames.length
        ? result.usernames.map((name) => `- ${name}`).join("\n")
        : "No players online.";

      const embed = new EmbedBuilder()
        .setTitle(`${result.count}/${result.total} Players Online`)
        .setDescription(`**List of Players:**\n${playerList}`)
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.tag}` });

      await safeInteractionEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      await safeInteractionEditReply(interaction, `Failed to fetch the player list: ${error.message}`);
    }

    return;
  }

  if (interaction.commandName === "allowlist") {
    await interaction.deferReply({ ephemeral: true });

    if (!(await isInteractionAdmin(interaction))) {
      await safeInteractionEditReply(interaction, "You do not have permission to use this command.");
      return;
    }

    const username = interaction.options.getString("username", true).trim();
    if (!username) {
      await safeInteractionEditReply(interaction, "Please provide a valid username.");
      return;
    }

    try {
      await sendConsoleCommand(`allowlist add ${username}`);
      await safeInteractionEditReply(interaction, `✅ Sent allowlist command for **${username}** to the server console.`);
    } catch (error) {
      await safeInteractionEditReply(interaction, `Failed to send allowlist command: ${error.message}`);
    }

    return;
  }

  if (interaction.commandName === "worldinfo") {
    let deferred = false;
    try {
      await interaction.deferReply();
      deferred = true;
    } catch (err) {
      console.error("deferReply failed:", err.message);
      try {
        await safeInteractionReply(interaction, { content: "Processing...", ephemeral: true });
        deferred = true;
      } catch (err2) {
        console.error("fallback reply failed:", err2.message);
      }
    }

    if (!deferred) {
      console.error("Could not acknowledge interaction, aborting worldinfo handler.");
      return;
    }

    try {
      const host = process.env.SERVER_IP;
      const port = Number(process.env.SERVER_PORT || 25565);

      const pingResult = await pingServer(host, port, 3000);
      const listResult = await requestPlayerList().catch(() => ({ count: null, total: null, usernames: [] }));

      let daytime = null;
      try {
        const lines = await requestConsoleResponse("time query daytime", /Daytime\s+is\s*(\d+)/i, 3000);
        const joined = (lines || []).join(" ");
        const m = joined.match(/Daytime\s+is\s*(\d+)/i);
        if (m) daytime = Number(m[1]);
      } catch (err) {
        console.error("time query daytime failed:", err.message);
      }

      let dayNumber = null;
      try {
        const lines = await requestConsoleResponse("time query day", /Day\s+is\s*(\d+)/i, 3000);
        const joined = (lines || []).join(" ");
        const m = joined.match(/Day\s+is\s*(\d+)/i);
        if (m) dayNumber = Number(m[1]);
      } catch (err) {
        console.error("time query day failed:", err.message);
      }

      let weather = "Unknown";
      try {
        const lines = await requestConsoleResponse("weather query", /Weather\s+state\s+is[:\s]*[A-Za-z]+/i, 3000);
        const joined = (lines || []).join(" ");
        const m = joined.match(/Weather\s+state\s+is[:\s]*([A-Za-z]+)/i) || joined.match(/Weather[:\s]*([A-Za-z]+)/i) || joined.match(/weather\s+is[:\s]*([A-Za-z]+)/i);
        if (m) weather = m[1];
      } catch (err) {
        console.error("weather query failed:", err.message);
      }

      const timeDisplay = typeof daytime === "number" ? `${ticksToTime(daytime)} (${ticksToPhase(daytime)})` : "Unknown";
      const dayDisplay = typeof dayNumber === "number" ? `Day ${dayNumber}` : "Unknown";

      const playersDisplay = typeof listResult.count === "number" && typeof listResult.total === "number"
        ? `${listResult.count}/${listResult.total}`
        : (typeof pingResult.count === "number" && typeof pingResult.total === "number") ? `${pingResult.count}/${pingResult.total}` : "Unknown";

      const embed = new EmbedBuilder()
        .setTitle("🌍 World Information")
        .addFields(
          { name: "🟢 Status", value: pingResult.online ? "Online" : "Offline", inline: false },
          { name: "👥 Players", value: playersDisplay, inline: false },
          { name: "🌅 Time", value: timeDisplay, inline: false },
          { name: "📅 Day", value: dayDisplay, inline: false },
          { name: "☀️ Weather", value: weather, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `Requested by ${interaction.user.tag}` });

      await safeInteractionEditReply(interaction, { embeds: [embed] });
    } catch (error) {
      console.error("worldinfo handler failed:", error);
      try {
        await safeInteractionEditReply(interaction, `Failed to fetch world info: ${error.message}`);
      } catch {}
    }

    return;
  }
});

client.login(process.env.DISCORD_TOKEN);

"use strict";

/**
 * Heartbeat subsystem.
 *
 * Every `intervalMinutes` it sends a "Heartbeat {ISO datetime}" message to a
 * configured WhatsApp chat, then sweeps that same chat to delete any
 * heartbeat messages older than 3 * intervalMinutes.  That keeps exactly
 * ~3 heartbeat messages visible at any time when the system is healthy.
 */

const fs = require("fs").promises;
const path = require("path");

const CONFIG_PATH = path.join(
  process.env.DATA_PATH || "/data",
  ".heartbeat-config.json",
);

const HEARTBEAT_PREFIX = "Heartbeat ";
const MAX_VISIBLE = 3;

let _timer = null;
let _config = { enabled: false, chatName: "", intervalMinutes: 5 };
let _emitLog = null;
let _getClient = null;
let _resolveChatIdByName = null;

const defaultConfig = () => ({
  enabled: false,
  chatName: "",
  intervalMinutes: 5,
});

const loadConfig = async () => {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      chatName: typeof parsed.chatName === "string" ? parsed.chatName : "",
      intervalMinutes:
        Number.isFinite(parsed.intervalMinutes) && parsed.intervalMinutes >= 1
          ? parsed.intervalMinutes
          : 5,
    };
  } catch (_) {
    return defaultConfig();
  }
};

const saveConfig = async (cfg) => {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
};

const log = (level, msg, details = {}) => {
  if (_emitLog) {
    _emitLog(level, msg, { scope: "heartbeat", ...details });
  }
};

const resolveChatId = async (chatName) => {
  if (!chatName) return null;
  if (_resolveChatIdByName) {
    return await _resolveChatIdByName(chatName);
  }
  const client = _getClient && _getClient();
  if (!client) return null;
  const chats = await client.getChats();
  const normalized = chatName.trim().toLowerCase();
  const match = chats.find((c) => (c.name || "").toLowerCase() === normalized);
  return match ? match.id._serialized : null;
};

const isHeartbeatMessage = (msg) => {
  const body = typeof msg.body === "string" ? msg.body : "";
  return body.startsWith(HEARTBEAT_PREFIX) && msg.fromMe === true;
};

const sendHeartbeat = async () => {
  const cfg = _config;
  if (!cfg.enabled || !cfg.chatName) return;

  const client = _getClient && _getClient();
  if (!client) {
    log("warn", "Heartbeat skipped: WhatsApp client not ready");
    return;
  }

  let chatId;
  try {
    chatId = await resolveChatId(cfg.chatName);
  } catch (err) {
    log("warn", "Heartbeat: failed to resolve chat name", {
      chatName: cfg.chatName,
      error: String(err?.message || err),
    });
    return;
  }

  if (!chatId) {
    log("warn", "Heartbeat: chat not found", { chatName: cfg.chatName });
    return;
  }

  const now = new Date().toISOString();
  const messageText = `${HEARTBEAT_PREFIX}${now}`;

  try {
    await client.sendMessage(chatId, messageText);
    log("info", "Heartbeat sent", { chatId, message: messageText });
  } catch (err) {
    log("warn", "Heartbeat: failed to send message", {
      chatId,
      error: String(err?.message || err),
    });
    return;
  }

  // Delete heartbeat messages older than 3 * intervalMinutes.
  const cutoffMs = Date.now() - cfg.intervalMinutes * MAX_VISIBLE * 60 * 1000;
  try {
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 50 });
    const toDelete = messages.filter((msg) => {
      if (!isHeartbeatMessage(msg)) return false;
      const ts = Number(msg.timestamp) * 1000;
      return ts < cutoffMs;
    });
    for (const msg of toDelete) {
      try {
        await msg.delete(true);
        log("info", "Heartbeat: deleted old message", {
          messageId: msg.id?._serialized,
          timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
        });
      } catch (delErr) {
        log("warn", "Heartbeat: failed to delete old message", {
          messageId: msg.id?._serialized,
          error: String(delErr?.message || delErr),
        });
      }
    }
  } catch (err) {
    log("warn", "Heartbeat: failed to sweep old messages", {
      chatId,
      error: String(err?.message || err),
    });
  }
};

const stopTimer = () => {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
};

const startTimer = (intervalMinutes) => {
  stopTimer();
  const intervalMs = intervalMinutes * 60 * 1000;
  _timer = setInterval(() => {
    sendHeartbeat().catch((err) => {
      log("warn", "Heartbeat tick error", { error: String(err?.message || err) });
    });
  }, intervalMs);
  log("info", "Heartbeat timer started", { intervalMinutes });
};

const applyConfig = (cfg) => {
  _config = cfg;
  if (cfg.enabled && cfg.chatName && cfg.intervalMinutes >= 1) {
    startTimer(cfg.intervalMinutes);
  } else {
    stopTimer();
    if (!cfg.enabled) {
      log("info", "Heartbeat disabled");
    }
  }
};

/**
 * Initialise the heartbeat subsystem.
 * @param {object} opts
 * @param {() => any} opts.getClient  - returns active WhatsApp client or null
 * @param {Function} opts.emitLog     - writeRuntimeLog(level, msg, details)
 * @param {Function|null} [opts.resolveChatIdByName]
 */
const init = async ({ getClient, emitLog, resolveChatIdByName = null }) => {
  _getClient = getClient;
  _emitLog = emitLog;
  _resolveChatIdByName = resolveChatIdByName;

  const cfg = await loadConfig();
  applyConfig(cfg);
  return cfg;
};

const getConfig = () => ({ ..._config });

const updateConfig = async (patch) => {
  const next = {
    ..._config,
    ...patch,
  };
  if (typeof patch.enabled !== "undefined") next.enabled = Boolean(patch.enabled);
  if (typeof patch.chatName === "string") next.chatName = patch.chatName.trim();
  if (Number.isFinite(patch.intervalMinutes) && patch.intervalMinutes >= 1) {
    next.intervalMinutes = patch.intervalMinutes;
  }
  await saveConfig(next);
  applyConfig(next);
  log("info", "Heartbeat config updated", next);
  return next;
};

module.exports = { init, getConfig, updateConfig };

"use strict";

/**
 * Heartbeat subsystem.
 *
 * Every `intervalMinutes` it sends a "Heartbeat {ISO datetime}" message to a
 * configured WhatsApp chat, then sweeps that same chat to delete any
 * heartbeat messages older than 3 * intervalMinutes using "Delete for me"
 * semantics to avoid visible delete markers.
 */

const fs = require("fs").promises;
const path = require("path");

const CONFIG_PATH = path.join(
  process.env.DATA_PATH || "/data",
  ".heartbeat-config.json",
);
const STATE_PATH = path.join(
  process.env.DATA_PATH || "/data",
  ".heartbeat-state.json",
);

const HEARTBEAT_PREFIX = "Heartbeat ";
const MAX_VISIBLE = 3;

let _timer = null;
let _config = { enabled: false, chatName: "", intervalMinutes: 5 };
let _state = { sent: [] };
let _emitLog = null;
let _getClient = null;
let _resolveChatIdByName = null;

const defaultConfig = () => ({
  enabled: false,
  chatName: "",
  intervalMinutes: 5,
});

const defaultState = () => ({
  sent: [],
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

const loadState = async () => {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const sent = Array.isArray(parsed?.sent)
      ? parsed.sent
          .map((entry) => ({
            id: typeof entry?.id === "string" ? entry.id : "",
            sentAtMs: Number(entry?.sentAtMs),
          }))
          .filter((entry) => entry.id && Number.isFinite(entry.sentAtMs) && entry.sentAtMs > 0)
      : [];
    return { sent };
  } catch (_) {
    return defaultState();
  }
};

const saveState = async () => {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(_state, null, 2), "utf8");
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
  return body.includes(HEARTBEAT_PREFIX);
};

const trackSentHeartbeat = async (messageId, sentAtMs) => {
  if (!messageId || !Number.isFinite(sentAtMs) || sentAtMs <= 0) {
    return;
  }
  _state.sent.push({ id: messageId, sentAtMs });
  if (_state.sent.length > 300) {
    _state.sent = _state.sent.slice(_state.sent.length - 300);
  }
  try {
    await saveState();
  } catch (err) {
    log("warn", "Heartbeat: failed to persist state", {
      error: String(err?.message || err),
    });
  }
};

const getTrackedIdsToDelete = (cutoffMs) => {
  const agedIds = new Set(
    _state.sent.filter((entry) => entry.sentAtMs < cutoffMs).map((entry) => entry.id),
  );
  if (_state.sent.length > MAX_VISIBLE) {
    const overflow = _state.sent.length - MAX_VISIBLE;
    for (const entry of _state.sent.slice(0, overflow)) {
      agedIds.add(entry.id);
    }
  }
  return agedIds;
};

const sweepTrackedHeartbeats = async (client, cutoffMs) => {
  const idsToDelete = getTrackedIdsToDelete(cutoffMs);
  if (idsToDelete.size === 0) {
    return;
  }

  for (const messageId of idsToDelete) {
    try {
      const msg =
        typeof client.getMessageById === "function" ? await client.getMessageById(messageId) : null;
      if (!msg || !isHeartbeatMessage(msg) || typeof msg.delete !== "function") {
        continue;
      }
      // Use "Delete for me" to avoid leaving a visible "message deleted" trace.
      await msg.delete(false);
      log("trace", "Heartbeat: deleted old message", {
        messageId,
        deleteMode: "for_me",
      });
    } catch (delErr) {
      log("debug", "Heartbeat: tracked delete skipped", {
        messageId,
        error: String(delErr?.message || delErr),
      });
    }
  }

  _state.sent = _state.sent.filter((entry) => !idsToDelete.has(entry.id));
  try {
    await saveState();
  } catch (err) {
    log("warn", "Heartbeat: failed to persist state after sweep", {
      error: String(err?.message || err),
    });
  }
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

  let sentMessageId = null;
  const sentAtMs = Date.now();
  try {
    const response = await client.sendMessage(chatId, messageText);
    sentMessageId = response?.id?._serialized || null;
    log("debug", "Heartbeat sent", { chatId, message: messageText });
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
    if (sentMessageId) {
      await trackSentHeartbeat(sentMessageId, sentAtMs);
    }
    await sweepTrackedHeartbeats(client, cutoffMs);
    log("trace", "Heartbeat: sweep complete", {
      tracked: _state.sent.length,
      cutoff: new Date(cutoffMs).toISOString(),
    });
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
  log("debug", "Heartbeat timer started", { intervalMinutes });
};

const applyConfig = (cfg) => {
  _config = cfg;
  if (cfg.enabled && cfg.chatName && cfg.intervalMinutes >= 1) {
    startTimer(cfg.intervalMinutes);
  } else {
    stopTimer();
    if (!cfg.enabled) {
      log("debug", "Heartbeat disabled");
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

  _state = await loadState();
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
  log("debug", "Heartbeat config updated", next);
  return next;
};

module.exports = { init, getConfig, updateConfig };

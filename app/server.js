"use strict";

const { randomUUID } = require("crypto");
const path = require("path");
const QRCode = require("qrcode");
const {
  getClient,
  getMessageMediaClass,
  getQr,
  getQrConsole,
  getQrConsoleSingle,
  getQrConsoleBlock,
  getQrConsoleStyle,
  isInitialized,
  subscribeToEvents,
  subscribeToRuntimeLogs,
  getRuntimeLogs,
  writeRuntimeLog,
  getRuntimeState,
  getRuntimeIdentity,
  listGithubRefs,
  swapToChoice,
  getStartupPromise,
  WS_SUPPORTED_EVENTS,
} = require("./whatsappClient");
const heartbeat = require("./heartbeat");

// web server configuration
const fastify = require("fastify")({ logger: false });
fastify.register(require("@fastify/websocket"));

fastify.register(require("@fastify/view"), {
  engine: {
    ejs: require("ejs"),
  },
  root: path.join(__dirname, "templates"),
});

const logServer = (level, message, details = {}) => {
  writeRuntimeLog(level, message, { scope: "server", ...details });
};

fastify.addHook("onRequest", (request, _reply, done) => {
  request._logStartedAt = Date.now();
  if (typeof request.raw.url === "string" && request.raw.url.startsWith("//")) {
    request.raw.url = request.raw.url.replace(/^\/+/, "/");
  }
  done();
});

fastify.addHook("onResponse", (request, reply, done) => {
  const startedAt = Number.isFinite(request._logStartedAt) ? request._logStartedAt : Date.now();
  const durationMs = Date.now() - startedAt;
  logServer("info", "HTTP request", {
    method: request.method,
    path: request.raw.url || request.url,
    status: reply.statusCode,
    durationMs,
  });
  done();
});

const websocketSubscriptions = new Set();
const hotswapWsSubscriptions = new Set();
const uiStatusSubscriptions = new Set();
const supportedWsEvents = new Set(WS_SUPPORTED_EVENTS);
const isSocketOpen = (socket) => socket.readyState === socket.constructor.OPEN;
const runtimeIdentity = getRuntimeIdentity();
const APP_VERSION = process.env.APP_BUILD_VERSION || require("../package.json").version || "unknown";
const SUPERVISOR_BASE_URL = String(process.env.SUPERVISOR_BASE_URL || "http://supervisor").trim();
let integrationVersionFromWs = "unknown";
let integrationVersionFromWsAt = null;
let integrationVersionFromWsClientId = null;
const getSupervisorToken = () => String(process.env.SUPERVISOR_TOKEN || "").trim();
const canRestartHomeAssistant = () => Boolean(getSupervisorToken());
const checkSupervisorTokenValidity = async () => {
  const token = getSupervisorToken();
  if (!token) {
    return { hasToken: false, valid: false, status: "missing" };
  }
  try {
    const response = await fetch(`${SUPERVISOR_BASE_URL}/supervisor/info`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 200) {
      return { hasToken: true, valid: true, status: "valid" };
    }
    if (response.status === 401 || response.status === 403) {
      return { hasToken: true, valid: false, status: "invalid" };
    }
    return { hasToken: true, valid: false, status: `http_${response.status}` };
  } catch (_) {
    return { hasToken: true, valid: false, status: "unreachable" };
  }
};
const normalizeConnectionState = (value) => {
  const normalized =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "_")
      : "";
  return normalized || "starting";
};
const toShortConnectionState = (value) => normalizeConnectionState(value).slice(0, 16);
const isVersionMismatch = (addonVersion, integrationVersion) => {
  const addon = typeof addonVersion === "string" ? addonVersion.trim() : "";
  const integration = typeof integrationVersion === "string" ? integrationVersion.trim() : "";
  if (!addon || !integration || addon === "unknown" || integration === "unknown") {
    return false;
  }
  return addon !== integration;
};
const toTitleCaseName = (name) =>
  typeof name === "string" && name.length > 0 ? `${name[0].toUpperCase()}${name.slice(1)}` : "Whatsapper";
const getUiVersions = () => {
  const integrationVersion =
    typeof integrationVersionFromWs === "string" && integrationVersionFromWs.trim()
      ? integrationVersionFromWs.trim()
      : "unknown";
  const runtimeState = getRuntimeState();
  return {
    appName: runtimeIdentity.appName,
    appTitle: toTitleCaseName(runtimeIdentity.appName),
    appPort: runtimeIdentity.appPort,
    dirtyBuild: runtimeIdentity.dirtyBuild,
    devBuild: runtimeIdentity.devBuild ?? runtimeIdentity.dirtyBuild,
    whatsappWebJsVersion: runtimeState.installedVersion || "unknown",
    wwjsConnectionState: toShortConnectionState(runtimeState.connectionState || runtimeState.state),
    wwjsInitialized: Boolean(runtimeState.initialized),
    appVersion: APP_VERSION,
    integrationVersion,
    integrationVersionMismatch: isVersionMismatch(APP_VERSION, integrationVersion),
    integrationVersionSource:
      integrationVersionFromWsAt && integrationVersionFromWsClientId ? "events-ws" : "unknown",
  };
};
const getUiStatus = () => {
  const versions = getUiVersions();
  const qrAvailable = Boolean(getQr());
  const initialized = Boolean(versions.wwjsInitialized);
  const connectionState = versions.wwjsConnectionState || "starting";
  const qrNeedsAttention = qrAvailable || !initialized;
  const qrMeta = initialized && !qrAvailable ? "ok" : connectionState;
  const qrSubtitle =
    initialized && !qrAvailable
      ? "Activate login if needed"
      : `Waiting for WhatsApp (${connectionState})`;
  return {
    ...versions,
    qrNeedsAttention,
    qrMeta,
    qrSubtitle,
    qrDimmed: !qrNeedsAttention,
    canRestartHomeAssistant: canRestartHomeAssistant(),
    generatedAt: new Date().toISOString(),
  };
};

const readResponseBody = async (response) => {
  try {
    const payload = await response.json();
    return typeof payload === "object" ? payload : null;
  } catch (_) {
    try {
      return { raw: await response.text() };
    } catch (_) {
      return null;
    }
  }
};

const requestHomeAssistantRestart = async () => {
  const token = getSupervisorToken();
  if (!token) {
    throw new Error(
      "Home Assistant restart is unavailable (missing SUPERVISOR_TOKEN). " +
        "Set 'hassio_api: true' in the add-on config.yaml and restart the add-on.",
    );
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const attempts = [
    { mode: "supervisor_core_restart", path: "/core/restart", body: null },
    {
      mode: "homeassistant_service_restart",
      path: "/core/api/services/homeassistant/restart",
      body: {},
    },
  ];
  const failures = [];
  for (const attempt of attempts) {
    try {
      const response = await fetch(`${SUPERVISOR_BASE_URL}${attempt.path}`, {
        method: "POST",
        headers,
        ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}),
      });
      if (response.ok) {
        const payload = await readResponseBody(response);
        return {
          mode: attempt.mode,
          status: response.status,
          payload,
        };
      }
      const failedBody = await readResponseBody(response);
      failures.push(
        `${attempt.path} => HTTP ${response.status} ${
          failedBody && failedBody.raw ? failedBody.raw : ""
        }`.trim(),
      );
    } catch (error) {
      failures.push(`${attempt.path} => ${String(error?.message || error)}`);
    }
  }
  throw new Error(`Failed to restart Home Assistant: ${failures.join("; ")}`);
};

const wsStats = {
  startedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  totalConnectionsAccepted: 0,
  totalConnectionsClosed: 0,
  eventsConnectionsAccepted: 0,
  runtimeConnectionsAccepted: 0,
  messagesIn: 0,
  messagesOut: 0,
  eventsBroadcasts: 0,
  runtimeBroadcasts: 0,
  rpcRequests: 0,
  rpcResponses: 0,
  rpcErrors: 0,
};

const wsClients = new Map();
const reactionToggleState = new Map();
const REACTION_TOGGLE_LIMIT = 2000;

const setReactionToggle = (messageId, reaction) => {
  if (!reactionToggleState.has(messageId) && reactionToggleState.size >= REACTION_TOGGLE_LIMIT) {
    const firstKey = reactionToggleState.keys().next().value;
    if (firstKey) {
      reactionToggleState.delete(firstKey);
    }
  }
  reactionToggleState.set(messageId, reaction);
};

const updateIntegrationVersionFromWs = (client, version, details = {}) => {
  if (typeof version !== "string") {
    return false;
  }
  const normalizedVersion = version.trim();
  if (!normalizedVersion) {
    return false;
  }
  integrationVersionFromWs = normalizedVersion;
  integrationVersionFromWsAt = new Date().toISOString();
  integrationVersionFromWsClientId = client?.id || null;
  logServer("info", "Integration version updated via events ws", {
    clientId: integrationVersionFromWsClientId || "-",
    integrationVersion: normalizedVersion,
    source: "events-ws",
    ...details,
  });
  broadcastUiStatus("integration_version_response");
  return true;
};

const getPayloadSize = (payload) => {
  if (typeof payload === "string") {
    return payload.length;
  }
  try {
    return JSON.stringify(payload).length;
  } catch (_) {
    return 0;
  }
};

const registerWsClient = ({ channel, socket, request, selectedEvents = null }) => {
  const client = {
    id: randomUUID(),
    channel,
    socket,
    connectedAt: new Date().toISOString(),
    remoteAddress: request?.socket?.remoteAddress || null,
    userAgent: request?.headers?.["user-agent"] || null,
    selectedEvents: selectedEvents ? Array.from(selectedEvents) : null,
    messagesIn: 0,
    messagesOut: 0,
    lastInAt: null,
    lastOutAt: null,
    lastInType: null,
    lastOutType: null,
  };

  wsClients.set(client.id, client);
  wsStats.totalConnectionsAccepted += 1;
  if (channel === "events") {
    wsStats.eventsConnectionsAccepted += 1;
  } else if (channel === "runtime") {
    wsStats.runtimeConnectionsAccepted += 1;
  }

  logServer("info", "WebSocket connected", {
    channel: client.channel,
    clientId: client.id,
    remoteAddress: client.remoteAddress || "-",
    selectedEvents: Array.isArray(client.selectedEvents)
      ? client.selectedEvents.join(",")
      : "-",
  });
  return client;
};

const unregisterWsClient = (client, reason = "unknown") => {
  if (!client) {
    return;
  }
  if (!wsClients.delete(client.id)) {
    return;
  }

  wsStats.totalConnectionsClosed += 1;
  logServer("info", "WebSocket disconnected", {
    channel: client.channel,
    clientId: client.id,
    reason,
  });
};

const logWsTraffic = ({ client, direction, payload, messageType = null, parsedPayload = null }) => {
  let topic = null;
  if (parsedPayload?.type === "rpc") {
    topic = `rpc:${parsedPayload.action || "unknown"}`;
  } else if (parsedPayload?.type === "rpc_result") {
    topic = `rpc_result:${parsedPayload.requestId || "-"}`;
  } else if (typeof parsedPayload?.event === "string" && parsedPayload.event.trim()) {
    topic = `event:${parsedPayload.event.trim()}`;
  } else if (typeof parsedPayload?.type === "string" && parsedPayload.type.trim()) {
    topic = parsedPayload.type.trim();
  } else if (typeof messageType === "string" && messageType.trim()) {
    topic = messageType.trim();
  }
  const details = {
    channel: client.channel,
    clientId: client.id,
    direction,
    type: messageType || "raw",
    size: getPayloadSize(payload),
    topic: topic || "raw",
  };
  if (parsedPayload?.type === "rpc") {
    details.rpcAction = parsedPayload.action || "unknown";
    details.requestId = parsedPayload.requestId || "-";
  } else if (parsedPayload?.type === "rpc_result") {
    details.requestId = parsedPayload.requestId || "-";
    details.rpcOk = parsedPayload.ok === false ? "false" : "true";
  }
  // Keep WS traffic logs concise; topic/direction already carry the useful context.
  logServer("info", "ws", details);
};

const markWsInbound = (client, rawPayload, parsedPayload = null) => {
  client.messagesIn += 1;
  wsStats.messagesIn += 1;
  client.lastInAt = new Date().toISOString();
  client.lastInType = parsedPayload?.type || parsedPayload?.event || "raw";
  logWsTraffic({
    client,
    direction: "in",
    payload: rawPayload,
    messageType: client.lastInType,
    parsedPayload,
  });
};

const sendWsPayload = (client, payload, options = {}) => {
  const suppressTrafficLog = Boolean(options.suppressTrafficLog);
  if (!isSocketOpen(client.socket)) {
    unregisterWsClient(client, "socket_closed");
    return false;
  }

  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);

  try {
    client.socket.send(serialized);
    client.messagesOut += 1;
    wsStats.messagesOut += 1;
    client.lastOutAt = new Date().toISOString();
    client.lastOutType = payload?.type || payload?.event || "raw";
    if (!suppressTrafficLog) {
      logWsTraffic({
        client,
        direction: "out",
        payload,
        messageType: client.lastOutType,
        parsedPayload: typeof payload === "object" ? payload : null,
      });
    }
    return true;
  } catch (error) {
    logServer("warn", "Failed to send websocket payload", {
      channel: client.channel,
      clientId: client.id,
      error: String(error?.message || error),
    });
    unregisterWsClient(client, "send_failed");
    return false;
  }
};

const getWsSnapshot = () => {
  const clients = Array.from(wsClients.values()).map((client) => ({
    id: client.id,
    channel: client.channel,
    connectedAt: client.connectedAt,
    remoteAddress: client.remoteAddress,
    userAgent: client.userAgent,
    selectedEvents: client.selectedEvents,
    messagesIn: client.messagesIn,
    messagesOut: client.messagesOut,
    lastInAt: client.lastInAt,
    lastOutAt: client.lastOutAt,
    lastInType: client.lastInType,
    lastOutType: client.lastOutType,
  }));

  const currentEventsClients = clients.filter((client) => client.channel === "events").length;
  const currentRuntimeClients = clients.filter((client) => client.channel === "runtime").length;
  const { startedAtMs, ...totals } = wsStats;

  return {
    generatedAt: new Date().toISOString(),
    uptimeMs: Date.now() - startedAtMs,
    totals,
    current: {
      totalClients: clients.length,
      eventsClients: currentEventsClients,
      runtimeClients: currentRuntimeClients,
    },
    clients: clients.sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1)),
  };
};

const buildQrImageBuffer = async (qrPayload) => {
  if (!qrPayload) {
    return null;
  }

  try {
    return await QRCode.toBuffer(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 360,
      color: {
        dark: "#111111",
        light: "#ffffff",
      },
    });
  } catch (error) {
    logServer("warn", "Failed to render QR image", { error: String(error?.message || error) });
    return null;
  }
};

const ensureActiveClient = () => {
  if (!isInitialized()) {
    return null;
  }
  return getClient();
};

const listChats = async () => {
  const activeClient = ensureActiveClient();
  if (!activeClient) {
    throw new Error("Client not initialized");
  }

  const resp = await activeClient.getChats();
  const formatMessageTimestamp = (rawTimestamp) => {
    const timestampNumber = Number(rawTimestamp);
    if (!Number.isFinite(timestampNumber) || timestampNumber <= 0) {
      return null;
    }
    const date = new Date(timestampNumber * 1000);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString();
  };
  return resp.map((chat) => ({
    name: chat.name || "",
    id: chat.id._serialized,
    isGroup: Boolean(chat.isGroup),
    unreadCount: Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0,
    isMuted: Boolean(chat.isMuted),
    lastMessagePreview:
      (typeof chat.lastMessage?.body === "string" && chat.lastMessage.body.trim()) ||
      (chat.lastMessage?.hasMedia ? "[media]" : ""),
    lastMessageFromMe: Boolean(chat.lastMessage?.fromMe),
    lastMessageAt: formatMessageTimestamp(chat.lastMessage?.timestamp),
  }));
};

const parseWsEventSelection = (requestedEvents) => {
  if (requestedEvents === undefined || requestedEvents === null || requestedEvents === "") {
    return { selectedEvents: new Set(["message"]) };
  }

  const flat = Array.isArray(requestedEvents)
    ? requestedEvents.join(",")
    : String(requestedEvents);
  const selectedEvents = new Set(
    flat
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (selectedEvents.size === 0) {
    return { selectedEvents: new Set(["message"]) };
  }

  for (const eventName of selectedEvents) {
    if (!supportedWsEvents.has(eventName)) {
      return {
        error: `Unsupported event '${eventName}'. Supported events: ${Array.from(
          supportedWsEvents,
        ).join(", ")}`,
      };
    }
  }

  return { selectedEvents };
};

const resolveChatMatches = (chats, queryName) => {
  const normalizedQueryName = queryName.toLowerCase();
  const exactMatches = chats.filter((chat) => chat.name === queryName);
  const exactCaseInsensitiveMatches = chats.filter(
    (chat) => chat.name.toLowerCase() === normalizedQueryName,
  );
  const containsMatches = chats.filter((chat) => chat.name.toLowerCase().includes(normalizedQueryName));

  const seenChatIds = new Set();
  const matches = [];
  for (const candidateSet of [exactMatches, exactCaseInsensitiveMatches, containsMatches]) {
    for (const chat of candidateSet) {
      if (!seenChatIds.has(chat.id)) {
        seenChatIds.add(chat.id);
        matches.push(chat);
      }
    }
  }
  return matches;
};

const handleWsRpcRequest = async (rpcPayload) => {
  if (rpcPayload?.type !== "rpc") {
    throw new Error("Unsupported websocket message type");
  }

  const action = typeof rpcPayload.action === "string" ? rpcPayload.action : "";
  const params =
    rpcPayload && typeof rpcPayload.params === "object" && rpcPayload.params !== null
      ? rpcPayload.params
      : {};

  switch (action) {
    case "resolve_chat": {
      const queryName = typeof params.name === "string" ? params.name.trim() : "";
      if (!queryName) {
        throw new Error("Missing params.name for resolve_chat");
      }
      const chats = await listChats();
      const matches = resolveChatMatches(chats, queryName);
      return { query: queryName, matches };
    }

    case "send_message": {
      const chatId = typeof params.chatId === "string" ? params.chatId.trim() : "";
      const message = typeof params.message === "string" ? params.message : "";
      const quotedMessageId =
        typeof params.quotedMessageId === "string" ? params.quotedMessageId.trim() : "";
      if (!chatId) {
        throw new Error("Missing params.chatId for send_message");
      }
      const activeClient = ensureActiveClient();
      if (!activeClient) {
        throw new Error("Client not initialized");
      }
      logServer("info", "RPC send_message params", {
        chatId: chatId || "-",
        quotedMessageId: quotedMessageId || "-",
        messageLength: message.length,
      });
      const sendOptions = quotedMessageId ? { quotedMessageId } : undefined;
      const response = sendOptions
        ? await activeClient.sendMessage(chatId, message, sendOptions)
        : await activeClient.sendMessage(chatId, message);
      return {
        chatId,
        messageId: response?.id?._serialized || null,
        quotedMessageId: quotedMessageId || null,
      };
    }

    case "send_media": {
      const chatId = typeof params.chatId === "string" ? params.chatId.trim() : "";
      const mimeType = typeof params.mimeType === "string" ? params.mimeType.trim() : "";
      const data = typeof params.data === "string" ? params.data : "";
      const filename = typeof params.filename === "string" ? params.filename : "attachment";
      if (!chatId || !mimeType || !data) {
        throw new Error("send_media requires params.chatId, params.mimeType and params.data");
      }
      const activeClient = ensureActiveClient();
      if (!activeClient) {
        throw new Error("Client not initialized");
      }
      const MessageMedia = getMessageMediaClass();
      const media = new MessageMedia(mimeType, data, filename);
      const response = await activeClient.sendMessage(chatId, media);
      return { chatId, messageId: response?.id?._serialized || null };
    }

    case "react_message": {
      const messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
      const reaction = typeof params.reaction === "string" ? params.reaction.trim() : "";
      const toggle =
        params.toggle === true ||
        params.toggle === "true" ||
        params.toggle === 1 ||
        params.toggle === "1";
      if (!messageId) {
        throw new Error("Missing params.messageId for react_message");
      }
      if (!reaction) {
        throw new Error("Missing params.reaction for react_message");
      }
      const activeClient = ensureActiveClient();
      if (!activeClient) {
        throw new Error("Client not initialized");
      }
      logServer("info", "RPC react_message params", {
        messageId: messageId || "-",
        reaction,
        toggle,
      });
      if (typeof activeClient.getMessageById !== "function") {
        throw new Error("Client does not support getMessageById");
      }
      const targetMessage = await activeClient.getMessageById(messageId);
      if (!targetMessage) {
        throw new Error(`Message '${messageId}' not found`);
      }
      if (typeof targetMessage.react !== "function") {
        throw new Error("Target message does not support react()");
      }
      const previousReaction = reactionToggleState.get(messageId);
      const shouldToggleOff = toggle && previousReaction === reaction;
      const reactionToApply = shouldToggleOff ? "" : reaction;
      await targetMessage.react(reactionToApply);
      if (toggle) {
        if (shouldToggleOff) {
          reactionToggleState.delete(messageId);
        } else {
          setReactionToggle(messageId, reaction);
        }
      }
      logServer("info", "RPC react_message applied", {
        messageId,
        requestedReaction: reaction,
        appliedReaction: reactionToApply || "(removed)",
        toggled: toggle,
        removed: shouldToggleOff,
      });
      return {
        messageId,
        reaction,
        appliedReaction: reactionToApply || null,
        toggled: toggle,
        removed: shouldToggleOff,
        reacted: true,
      };
    }

    default:
      throw new Error(`Unsupported rpc action '${action}'`);
  }
};

const broadcastEvent = (envelope) => {
  for (const subscription of websocketSubscriptions) {
    if (!subscription.selectedEvents.has(envelope.event)) {
      continue;
    }

    wsStats.eventsBroadcasts += 1;
    if (!sendWsPayload(subscription.client, envelope)) {
      websocketSubscriptions.delete(subscription);
    }
  }
};

const broadcastRuntimeLog = (entry) => {
  for (const client of hotswapWsSubscriptions) {
    wsStats.runtimeBroadcasts += 1;
    if (!sendWsPayload(client, entry, { suppressTrafficLog: true })) {
      hotswapWsSubscriptions.delete(client);
    }
  }
};

const shouldBroadcastUiStatusForEvent = (eventName) =>
  eventName === "qr" ||
  eventName === "ready" ||
  eventName === "disconnected" ||
  eventName === "change_state";

const broadcastUiStatus = (reason = "update") => {
  const payload = {
    type: "ui_status",
    reason,
    timestamp: new Date().toISOString(),
    data: getUiStatus(),
  };
  for (const client of uiStatusSubscriptions) {
    if (!sendWsPayload(client, payload, { suppressTrafficLog: true })) {
      uiStatusSubscriptions.delete(client);
    }
  }
};

const unsubscribeFromClientEvents = subscribeToEvents((envelope) => {
  broadcastEvent(envelope);
  if (shouldBroadcastUiStatusForEvent(envelope.event)) {
    broadcastUiStatus(`event:${envelope.event}`);
  }
});

const unsubscribeFromRuntimeLogs = subscribeToRuntimeLogs((entry) => {
  broadcastRuntimeLog(entry);
});

fastify.addHook("onClose", (_instance, done) => {
  unsubscribeFromClientEvents();
  unsubscribeFromRuntimeLogs();
  uiStatusSubscriptions.clear();
  done();
});

fastify.get("/", function handler(_, reply) {
  reply.view("root.ejs", getUiStatus());
});

fastify.get("/hotswap", function handler(_, reply) {
  reply.view("hotswap.ejs", getUiVersions());
});

fastify.get("/logs", function handler(_, reply) {
  reply.view("logs.ejs", getUiVersions());
});

fastify.get("/ws-clients", function handler(_, reply) {
  reply.view("ws-clients.ejs", getUiVersions());
});

fastify.get("/send-test", function handler(_, reply) {
  reply.view("send-test.ejs", getUiVersions());
});

fastify.post("/api/v1/send-test", async function handler(request, reply) {
  const { chatId, message } = request.body || {};
  if (typeof chatId !== "string" || !chatId.trim()) {
    reply.statusCode = 400;
    return reply.send({ error: "Missing chatId" });
  }
  if (typeof message !== "string" || !message.trim()) {
    reply.statusCode = 400;
    return reply.send({ error: "Missing message" });
  }
  const activeClient = ensureActiveClient();
  if (!activeClient) {
    reply.statusCode = 503;
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const response = await activeClient.sendMessage(chatId.trim(), message.trim());
    logServer("info", "Send-test message sent", { chatId: chatId.trim(), messageLength: message.trim().length });
    return reply.send({ ok: true, messageId: response?.id?._serialized || null });
  } catch (error) {
    reply.statusCode = 500;
    return reply.send({ error: String(error?.message || error) });
  }
});

fastify.get("/qr", function handler(_, reply) {
  const qrPayload = getQr();
  return reply.view("qr.ejs", {
    qr: qrPayload,
    qrImagePath: "api/v1/qr/image",
    qrConsole: getQrConsole(),
    qrConsoleSingle: getQrConsoleSingle(),
    qrConsoleBlock: getQrConsoleBlock(),
    qrConsoleStyle: getQrConsoleStyle(),
    initialized: isInitialized(),
    ...getUiVersions(),
  });
});

fastify.get("/api/v1/ws/clients", function handler(_, reply) {
  return reply.send(getWsSnapshot());
});

fastify.get("/api/v1/qr/image", async function handler(_, reply) {
  const qrPayload = getQr();
  if (!qrPayload) {
    reply.statusCode = 404;
    return reply.send({ error: "QR not available" });
  }

  try {
    const imageBuffer = await buildQrImageBuffer(qrPayload);
    if (!imageBuffer) {
      reply.statusCode = 404;
      return reply.send({ error: "QR not available" });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", "inline; filename=\"qr.png\"");
    reply.type("image/png");
    return reply.send(imageBuffer);
  } catch (error) {
    reply.statusCode = 500;
    return reply.send({ error: String(error?.message || error) });
  }
});

fastify.get("/chats", async function handler(_, reply) {
  if (!isInitialized()) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const chats = await listChats();
    return reply.view("chats.ejs", { chats: chats });
  } catch (e) {
    reply.statusCode = 500;
    reply.send({ error: e });
  }
});

fastify.get("/api/v1/chats", async function handler(request, reply) {
  if (!isInitialized()) {
    reply.statusCode = 503;
    return reply.send({ error: "Client not initialized" });
  }

  try {
    const chats = await listChats();
    const queryName =
      typeof request.query?.name === "string" ? request.query.name.trim() : "";

    if (!queryName) {
      return reply.send({ chats });
    }

    const matches = resolveChatMatches(chats, queryName);

    return reply.send({ query: queryName, matches });
  } catch (e) {
    reply.statusCode = 500;
    return reply.send({ error: e });
  }
});

fastify.get("/api/v1/wwebjs/runtime", async function handler(_, reply) {
  await getStartupPromise();
  return reply.send(getRuntimeState());
});

fastify.post("/api/v1/ha/restart", async function handler(_, reply) {
  if (!canRestartHomeAssistant()) {
    reply.statusCode = 503;
    return reply.send({
      ok: false,
      error:
        "Home Assistant restart is unavailable in this runtime. " +
        "Set 'hassio_api: true' in the add-on config.yaml and restart the add-on.",
    });
  }
  try {
    const result = await requestHomeAssistantRestart();
    logServer("warn", "Home Assistant restart requested from UI", {
      mode: result.mode,
      status: result.status,
    });
    return reply.send({ ok: true, result });
  } catch (error) {
    reply.statusCode = 502;
    return reply.send({ ok: false, error: String(error?.message || error) });
  }
});

fastify.get("/api/v1/wwebjs/refs", async function handler(request, reply) {
  try {
    const refresh = request.query?.refresh === "1";
    const payload = await listGithubRefs({ refresh });
    return reply.send(payload);
  } catch (error) {
    reply.statusCode = 500;
    return reply.send({
      error: "Failed to fetch refs from GitHub",
      details: String(error?.message || error),
    });
  }
});

fastify.post("/api/v1/wwebjs/hotswap", async function handler(request, reply) {
  const choice = request.body?.choice;
  if (typeof choice !== "string") {
    reply.statusCode = 400;
    return reply.send({ error: "Missing choice in request body" });
  }

  try {
    const result = await swapToChoice(choice);
    broadcastUiStatus("hotswap");
    return reply.send({ ok: true, result });
  } catch (error) {
    const message = String(error?.message || error);
    reply.statusCode = message.includes("already in progress") ? 409 : 400;
    return reply.send({ error: message });
  }
});

fastify.post("/command", async function handler(request, reply) {
  const activeClient = ensureActiveClient();
  if (!activeClient) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const { command, params } = request.body;
    if (typeof activeClient[command] !== "function") {
      reply.statusCode = 400;
      return reply.send({ error: "Invalid command" });
    }
    const resp = await activeClient[command](...(params || []));
    reply.send({ resp: resp });
  } catch (e) {
    reply.statusCode = 500;
    reply.send({ error: e });
  }
});

fastify.post("/command/:type", async function handler(request, reply) {
  const activeClient = ensureActiveClient();
  if (!activeClient) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const { type } = request.params;
    const { params } = request.body;

    switch (type) {
      case "media": {
        const remote_id = params[0];
        const MessageMedia = getMessageMediaClass();
        const media = new MessageMedia(params[1], params[2], params[3]);

        const resp = await activeClient.sendMessage(remote_id, media);
        reply.send({ resp: resp });
        break;
      }
      default:
        reply.statusCode = 400;
        reply.send({ error: "Invalid type" });
    }
  } catch (e) {
    reply.statusCode = 500;
    reply.send({ error: e });
  }
});

fastify.after(() => {
  fastify.get(
    "/api/v1/ui/status",
    { websocket: true },
    function uiStatusWebSocket(socket, request) {
      const client = registerWsClient({
        channel: "ui",
        socket,
        request,
      });
      uiStatusSubscriptions.add(client);

      sendWsPayload(client, {
        type: "connected",
        timestamp: new Date().toISOString(),
        data: {
          channel: "ui",
        },
      });
      sendWsPayload(client, {
        type: "ui_status",
        reason: "connect",
        timestamp: new Date().toISOString(),
        data: getUiStatus(),
      });

      socket.on("message", (rawBuffer) => {
        const rawText = rawBuffer.toString();
        try {
          const payload = JSON.parse(rawText);
          markWsInbound(client, rawText, payload);
          if (payload?.type === "ping") {
            sendWsPayload(client, {
              type: "pong",
              timestamp: new Date().toISOString(),
            });
            return;
          }
          if (payload?.type === "ui_status_request") {
            sendWsPayload(client, {
              type: "ui_status",
              reason: "request",
              timestamp: new Date().toISOString(),
              data: getUiStatus(),
            });
          }
        } catch (_) {
          markWsInbound(client, rawText);
          // Ignore malformed messages for ui status socket.
        }
      });

      const teardown = (reason) => {
        uiStatusSubscriptions.delete(client);
        unregisterWsClient(client, reason);
      };
      socket.on("close", () => teardown("close"));
      socket.on("error", () => teardown("error"));
    },
  );

  fastify.get(
    "/api/v1/events/ws",
    { websocket: true },
    function eventsWebSocket(socket, request) {
      const selection = parseWsEventSelection(request.query?.events);
      if (selection.error) {
        socket.close(1008, selection.error);
        return;
      }

      const client = registerWsClient({
        channel: "events",
        socket,
        request,
        selectedEvents: selection.selectedEvents,
      });

      const subscription = {
        client,
        selectedEvents: selection.selectedEvents,
      };
      websocketSubscriptions.add(subscription);

      sendWsPayload(client, {
        type: "connected",
        timestamp: new Date().toISOString(),
        data: {
          selectedEvents: Array.from(selection.selectedEvents),
          availableEvents: Array.from(supportedWsEvents),
          clientInitialized: isInitialized(),
          currentQr: getQr(),
          currentQrConsole: getQrConsole(),
          currentQrConsoleSingle: getQrConsoleSingle(),
          currentQrConsoleBlock: getQrConsoleBlock(),
          currentQrConsoleStyle: getQrConsoleStyle(),
        },
      });
      sendWsPayload(client, {
        type: "integration_version_request",
        timestamp: new Date().toISOString(),
        data: {
          requestedBy: "addon",
          wanted: ["integrationVersion", "domain"],
        },
      });

      socket.on("message", async (rawBuffer) => {
        const rawText = rawBuffer.toString();
        let payload = null;
        try {
          payload = JSON.parse(rawText);
          markWsInbound(client, rawText, payload);

          if (payload?.type === "ping") {
            sendWsPayload(client, {
              type: "pong",
              timestamp: new Date().toISOString(),
            });
            return;
          }

          if (payload?.type === "integration_version_response") {
            const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
            const integrationVersion =
              typeof data.integrationVersion === "string" ? data.integrationVersion : "";
            updateIntegrationVersionFromWs(client, integrationVersion, {
              domain: typeof data.domain === "string" ? data.domain : "-",
            });
            return;
          }

          if (payload?.type === "rpc") {
            wsStats.rpcRequests += 1;
            const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
            const rpcParams =
              payload.params && typeof payload.params === "object" ? payload.params : {};
            logServer("info", "RPC request", {
              channel: "events",
              clientId: client.id,
              action: payload.action || "unknown",
              requestId: requestId || "-",
              paramKeys: Object.keys(rpcParams).join(",") || "-",
              hasReplyTo:
                typeof rpcParams.quotedMessageId === "string" ||
                typeof rpcParams.messageId === "string",
            });
            try {
              const result = await handleWsRpcRequest(payload);
              wsStats.rpcResponses += 1;
              logServer("info", "RPC response", {
                channel: "events",
                clientId: client.id,
                action: payload.action || "unknown",
                requestId: requestId || "-",
                ok: "true",
              });
              sendWsPayload(client, {
                type: "rpc_result",
                requestId,
                ok: true,
                result,
                timestamp: new Date().toISOString(),
              });
            } catch (error) {
              wsStats.rpcErrors += 1;
              logServer("warn", "RPC response", {
                channel: "events",
                clientId: client.id,
                action: payload.action || "unknown",
                requestId: requestId || "-",
                ok: "false",
                error: String(error?.message || error),
              });
              sendWsPayload(client, {
                type: "rpc_result",
                requestId,
                ok: false,
                error: String(error?.message || error),
                timestamp: new Date().toISOString(),
              });
            }
          }
        } catch (_) {
          markWsInbound(client, rawText);
          // Ignore malformed client messages. This endpoint is event-stream first.
        }
      });

      const teardown = (reason) => {
        websocketSubscriptions.delete(subscription);
        unregisterWsClient(client, reason);
      };
      socket.on("close", () => teardown("close"));
      socket.on("error", () => teardown("error"));
    },
  );

  fastify.get(
    "/api/v1/wwebjs/ws",
    { websocket: true },
    function wwebjsRuntimeWebSocket(socket, request) {
      const client = registerWsClient({
        channel: "runtime",
        socket,
        request,
      });
      hotswapWsSubscriptions.add(client);

      sendWsPayload(client, {
        type: "snapshot",
        state: getRuntimeState(),
        logs: getRuntimeLogs(),
        timestamp: new Date().toISOString(),
      });

      listGithubRefs()
        .then((payload) => {
          if (!isSocketOpen(client.socket)) {
            return;
          }
          sendWsPayload(client, {
            type: "refs",
            payload,
            timestamp: new Date().toISOString(),
          });
        })
        .catch((error) => {
          if (!isSocketOpen(client.socket)) {
            return;
          }
          sendWsPayload(client, {
            type: "log",
            level: "error",
            message: "Failed to fetch refs for hotswap UI",
            details: { error: String(error?.message || error) },
            timestamp: new Date().toISOString(),
          });
        });

      socket.on("message", async (rawBuffer) => {
        const rawText = rawBuffer.toString();
        try {
          const payload = JSON.parse(rawText);
          markWsInbound(client, rawText, payload);
          if (payload?.type === "ping") {
            sendWsPayload(client, {
              type: "pong",
              timestamp: new Date().toISOString(),
            });
            return;
          }

          if (payload?.type === "refresh_refs") {
            logServer("info", "Runtime refs refresh requested", {
              channel: "runtime",
              clientId: client.id,
            });
            const refsPayload = await listGithubRefs({ refresh: true });
            sendWsPayload(client, {
              type: "refs",
              payload: refsPayload,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (_) {
          markWsInbound(client, rawText);
          // Ignore malformed control messages for runtime socket.
        }
      });

      const teardown = (reason) => {
        hotswapWsSubscriptions.delete(client);
        unregisterWsClient(client, reason);
      };
      socket.on("close", () => teardown("close"));
      socket.on("error", () => teardown("error"));
    },
  );
});

fastify.get("/api/v1/heartbeat/config", function handler(_, reply) {
  return reply.send(heartbeat.getConfig());
});

fastify.post("/api/v1/heartbeat/config", async function handler(request, reply) {
  const body = request.body || {};
  const patch = {};
  if (typeof body.enabled !== "undefined") patch.enabled = body.enabled;
  if (typeof body.chatName === "string") patch.chatName = body.chatName;
  if (typeof body.intervalMinutes !== "undefined") {
    const n = Number(body.intervalMinutes);
    if (!Number.isFinite(n) || n < 1) {
      reply.statusCode = 400;
      return reply.send({ error: "intervalMinutes must be a number >= 1" });
    }
    patch.intervalMinutes = n;
  }
  try {
    const updated = await heartbeat.updateConfig(patch);
    return reply.send(updated);
  } catch (err) {
    reply.statusCode = 500;
    return reply.send({ error: String(err?.message || err) });
  }
});

fastify.listen({ port: runtimeIdentity.appPort, host: "0.0.0.0" }, (err) => {
  if (err) {
    logServer("error", "Fastify listen failed", { error: String(err?.message || err) });
    process.exit(1);
  }
  logServer("info", "HTTP server listening", {
    host: "0.0.0.0",
    port: runtimeIdentity.appPort,
  });
  checkSupervisorTokenValidity()
    .then((tokenCheck) => {
      logServer(tokenCheck.valid ? "info" : "warn", "Supervisor token status", {
        tokenValidity: tokenCheck.status,
      });
    })
    .catch((tokenErr) => {
      logServer("warn", "Supervisor token status check failed", {
        error: String(tokenErr?.message || tokenErr),
      });
    });

  heartbeat.init({
    getClient: ensureActiveClient,
    emitLog: writeRuntimeLog,
  }).then((cfg) => {
    logServer("info", "Heartbeat subsystem initialised", cfg);
  }).catch((err) => {
    logServer("warn", "Heartbeat init failed", { error: String(err?.message || err) });
  });
});

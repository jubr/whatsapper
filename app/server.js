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
  getRuntimeState,
  getRuntimeIdentity,
  listGithubRefs,
  swapToChoice,
  getStartupPromise,
  WS_SUPPORTED_EVENTS,
} = require("./whatsappClient");

// web server configuration
const fastify = require("fastify")({ logger: true });
fastify.register(require("@fastify/websocket"));

fastify.register(require("@fastify/view"), {
  engine: {
    ejs: require("ejs"),
  },
  root: path.join(__dirname, "templates"),
});

fastify.addHook("onRequest", (request, _reply, done) => {
  if (typeof request.raw.url === "string" && request.raw.url.startsWith("//")) {
    request.raw.url = request.raw.url.replace(/^\/+/, "/");
  }
  done();
});

const websocketSubscriptions = new Set();
const hotswapWsSubscriptions = new Set();
const supportedWsEvents = new Set(WS_SUPPORTED_EVENTS);
const isSocketOpen = (socket) => socket.readyState === socket.constructor.OPEN;
const runtimeIdentity = getRuntimeIdentity();
const APP_VERSION = process.env.APP_BUILD_VERSION || require("../package.json").version || "unknown";
const getUiVersions = () => ({
  appName: runtimeIdentity.appName,
  appPort: runtimeIdentity.appPort,
  dirtyBuild: runtimeIdentity.dirtyBuild,
  whatsappWebJsVersion: getRuntimeState().installedVersion || "unknown",
  appVersion: APP_VERSION,
});

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

const summarizeWsPayload = (payload) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (typeof text !== "string") {
    return "[non-string payload]";
  }
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
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

  fastify.log.info(
    {
      wsChannel: client.channel,
      wsClientId: client.id,
      remoteAddress: client.remoteAddress,
      selectedEvents: client.selectedEvents,
    },
    "WebSocket client connected",
  );
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
  fastify.log.info(
    { wsChannel: client.channel, wsClientId: client.id, reason },
    "WebSocket client disconnected",
  );
};

const logWsTraffic = ({ client, direction, payload, messageType = null }) => {
  fastify.log.info(
    {
      wsChannel: client.channel,
      wsClientId: client.id,
      direction,
      messageType,
      payload: summarizeWsPayload(payload),
    },
    "WebSocket message",
  );
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
  });
};

const sendWsPayload = (client, payload) => {
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
    logWsTraffic({
      client,
      direction: "out",
      payload: serialized,
      messageType: client.lastOutType,
    });
    return true;
  } catch (error) {
    fastify.log.warn(
      { error, wsChannel: client.channel, wsClientId: client.id },
      "Failed to send websocket payload",
    );
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
    fastify.log.warn({ error }, "Failed to render QR image");
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
  return resp.map((chat) => ({
    name: chat.name || "",
    id: chat.id._serialized,
    isGroup: Boolean(chat.isGroup),
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
    if (!sendWsPayload(client, entry)) {
      hotswapWsSubscriptions.delete(client);
    }
  }
};

const unsubscribeFromClientEvents = subscribeToEvents((envelope) => {
  broadcastEvent(envelope);
});

const unsubscribeFromRuntimeLogs = subscribeToRuntimeLogs((entry) => {
  broadcastRuntimeLog(entry);
});

fastify.addHook("onClose", (_instance, done) => {
  unsubscribeFromClientEvents();
  unsubscribeFromRuntimeLogs();
  done();
});

fastify.get("/", function handler(_, reply) {
  reply.view("root.ejs", getUiVersions());
});

fastify.get("/hotswap", function handler(_, reply) {
  reply.view("hotswap.ejs", getUiVersions());
});

fastify.get("/ws-clients", function handler(_, reply) {
  reply.view("ws-clients.ejs", getUiVersions());
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

          if (payload?.type === "rpc") {
            wsStats.rpcRequests += 1;
            const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
            try {
              const result = await handleWsRpcRequest(payload);
              wsStats.rpcResponses += 1;
              sendWsPayload(client, {
                type: "rpc_result",
                requestId,
                ok: true,
                result,
                timestamp: new Date().toISOString(),
              });
            } catch (error) {
              wsStats.rpcErrors += 1;
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

fastify.listen({ port: runtimeIdentity.appPort, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});

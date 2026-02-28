"use strict";

const path = require("path");
const {
  getClient,
  getMessageMediaClass,
  getQr,
  isInitialized,
  subscribeToEvents,
  subscribeToRuntimeLogs,
  getRuntimeLogs,
  getRuntimeState,
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

const websocketSubscriptions = new Set();
const hotswapWsSubscriptions = new Set();
const supportedWsEvents = new Set(WS_SUPPORTED_EVENTS);
const isSocketOpen = (socket) => socket.readyState === socket.constructor.OPEN;
const APP_VERSION = process.env.APP_BUILD_VERSION || require("../package.json").version || "unknown";
const getUiVersions = () => ({
  whatsappWebJsVersion: getRuntimeState().installedVersion || "unknown",
  appVersion: APP_VERSION,
});

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

const broadcastEvent = (envelope) => {
  const serializedEnvelope = JSON.stringify(envelope);

  for (const subscription of websocketSubscriptions) {
    if (!subscription.selectedEvents.has(envelope.event)) {
      continue;
    }

    if (!isSocketOpen(subscription.socket)) {
      websocketSubscriptions.delete(subscription);
      continue;
    }

    try {
      subscription.socket.send(serializedEnvelope);
    } catch (error) {
      fastify.log.warn({ error }, "Failed to send event over websocket");
      websocketSubscriptions.delete(subscription);
    }
  }
};

const broadcastRuntimeLog = (entry) => {
  const serializedEntry = JSON.stringify(entry);
  for (const socket of hotswapWsSubscriptions) {
    if (!isSocketOpen(socket)) {
      hotswapWsSubscriptions.delete(socket);
      continue;
    }
    try {
      socket.send(serializedEntry);
    } catch (_) {
      hotswapWsSubscriptions.delete(socket);
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

fastify.get("/qr", function handler(_, reply) {
  reply.view("qr.ejs", {
    qr: getQr(),
    initialized: isInitialized(),
    ...getUiVersions(),
  });
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

    const normalizedQueryName = queryName.toLowerCase();
    const exactMatches = chats.filter((chat) => chat.name === queryName);
    const exactCaseInsensitiveMatches = chats.filter(
      (chat) => chat.name.toLowerCase() === normalizedQueryName,
    );
    const containsMatches = chats.filter((chat) =>
      chat.name.toLowerCase().includes(normalizedQueryName),
    );

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

      const subscription = {
        socket,
        selectedEvents: selection.selectedEvents,
      };
      websocketSubscriptions.add(subscription);

      socket.send(
        JSON.stringify({
          type: "connected",
          timestamp: new Date().toISOString(),
          data: {
            selectedEvents: Array.from(selection.selectedEvents),
            availableEvents: Array.from(supportedWsEvents),
            clientInitialized: isInitialized(),
            currentQr: getQr(),
          },
        }),
      );

      socket.on("message", (rawBuffer) => {
        try {
          const payload = JSON.parse(rawBuffer.toString());
          if (payload?.type === "ping") {
            socket.send(
              JSON.stringify({
                type: "pong",
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } catch (_) {
          // Ignore malformed client messages. This endpoint is event-stream first.
        }
      });

      const teardown = () => websocketSubscriptions.delete(subscription);
      socket.on("close", teardown);
      socket.on("error", teardown);
    },
  );

  fastify.get(
    "/api/v1/wwebjs/ws",
    { websocket: true },
    function wwebjsRuntimeWebSocket(socket) {
      hotswapWsSubscriptions.add(socket);

      socket.send(
        JSON.stringify({
          type: "snapshot",
          state: getRuntimeState(),
          logs: getRuntimeLogs(),
          timestamp: new Date().toISOString(),
        }),
      );

      listGithubRefs()
        .then((payload) => {
          if (!isSocketOpen(socket)) {
            return;
          }
          socket.send(
            JSON.stringify({
              type: "refs",
              payload,
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((error) => {
          if (!isSocketOpen(socket)) {
            return;
          }
          socket.send(
            JSON.stringify({
              type: "log",
              level: "error",
              message: "Failed to fetch refs for hotswap UI",
              details: { error: String(error?.message || error) },
              timestamp: new Date().toISOString(),
            }),
          );
        });

      socket.on("message", async (rawBuffer) => {
        try {
          const payload = JSON.parse(rawBuffer.toString());
          if (payload?.type === "ping") {
            socket.send(
              JSON.stringify({
                type: "pong",
                timestamp: new Date().toISOString(),
              }),
            );
            return;
          }

          if (payload?.type === "refresh_refs") {
            const refsPayload = await listGithubRefs({ refresh: true });
            socket.send(
              JSON.stringify({
                type: "refs",
                payload: refsPayload,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } catch (_) {
          // Ignore malformed control messages for runtime socket.
        }
      });

      const teardown = () => hotswapWsSubscriptions.delete(socket);
      socket.on("close", teardown);
      socket.on("error", teardown);
    },
  );
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});

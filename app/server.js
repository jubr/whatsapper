"use strict";

const path = require("path");
const { MessageMedia } = require("whatsapp-web.js");
const {
  client,
  getQr,
  isInitialized,
  subscribeToEvents,
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
const supportedWsEvents = new Set(WS_SUPPORTED_EVENTS);
const isSocketOpen = (socket) => socket.readyState === socket.constructor.OPEN;

const listChats = async () => {
  const resp = await client.getChats();
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

const unsubscribeFromClientEvents = subscribeToEvents((envelope) => {
  broadcastEvent(envelope);
});

fastify.addHook("onClose", (_instance, done) => {
  unsubscribeFromClientEvents();
  done();
});

fastify.get("/", function handler(_, reply) {
  reply.view("root.ejs");
});

fastify.get("/qr", function handler(_, reply) {
  reply.view("qr.ejs", { qr: getQr(), initialized: isInitialized() });
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

fastify.post("/command", async function handler(request, reply) {
  if (!isInitialized()) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const { command, params } = request.body;
    // Check if client[command] is a function to avoid arbitrary code execution or errors
    if (typeof client[command] !== "function") {
      reply.statusCode = 400;
      return reply.send({ error: "Invalid command" });
    }
    const resp = await client[command](...params);
    reply.send({ resp: resp });
  } catch (e) {
    reply.statusCode = 500;
    reply.send({ error: e });
  }
});

fastify.post("/command/:type", async function handler(request, reply) {
  if (!isInitialized()) {
    return reply.send({ error: "Client not initialized" });
  }
  try {
    const { type } = request.params;
    const { params } = request.body;

    switch (type) {
      case "media": {
        const remote_id = params[0];
        const media = new MessageMedia(params[1], params[2], params[3]);

        const resp = await client.sendMessage(remote_id, media);
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
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});

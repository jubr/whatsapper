const { randomUUID } = require("crypto");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const client = new Client({
  puppeteer: {
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || "/data/.wwebjs_auth/",
  }),
  webVersionCache: {
    path: process.env.WWEBJS_CACHE_PATH || "/data/.wwebjs_cache/",
  },
});

let receivedQr = null;
let clientInitialized = false;
const eventSubscribers = new Set();

const WS_SUPPORTED_EVENTS = Object.freeze([
  "message",
  "ready",
  "qr",
  "disconnected",
  "change_state",
]);

const emitEvent = (event, data) => {
  const envelope = {
    eventId: randomUUID(),
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const callback of eventSubscribers) {
    try {
      callback(envelope);
    } catch (error) {
      console.error("Failed to dispatch Whatsapper event", error);
    }
  }
};

const serializeMessage = (message) => {
  const chatId = message?.fromMe ? message?.to : message?.from;
  return {
    id: message?.id?._serialized || null,
    chatId: chatId || null,
    from: message?.from || null,
    to: message?.to || null,
    author: message?.author || null,
    fromMe: Boolean(message?.fromMe),
    body: message?.body || "",
    type: message?.type || "unknown",
    timestamp: message?.timestamp || null,
    hasMedia: Boolean(message?.hasMedia),
    hasQuotedMsg: Boolean(message?.hasQuotedMsg),
    hasReaction: Boolean(message?.hasReaction),
    mentionedIds: Array.isArray(message?.mentionedIds) ? message.mentionedIds : [],
  };
};

// show qr code in console
client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  receivedQr = qr;
  qrcode.generate(qr, { small: true });
  emitEvent("qr", { qr });
});

client.on("ready", () => {
  clientInitialized = true;
  console.log("Client is ready!");
  emitEvent("ready", { initialized: true });
});

client.on("disconnected", (reason) => {
  clientInitialized = false;
  emitEvent("disconnected", { reason: reason || "UNKNOWN" });
});

client.on("change_state", (state) => {
  emitEvent("change_state", { state });
});

client.on("message", (message) => {
  emitEvent("message", serializeMessage(message));
});

client.initialize();

const subscribeToEvents = (callback) => {
  eventSubscribers.add(callback);
  return () => eventSubscribers.delete(callback);
};

module.exports = {
  client,
  getQr: () => receivedQr,
  isInitialized: () => clientInitialized,
  subscribeToEvents,
  WS_SUPPORTED_EVENTS,
};

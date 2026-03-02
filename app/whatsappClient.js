"use strict";

const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const QRCodeModel = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const packageJson = require("../package.json");

const APP_ROOT = path.resolve(__dirname, "..");
const PERSISTED_CHOICE_PATH =
  process.env.WWEBJS_RUNTIME_STATE_PATH || "/data/.whatsapp-webjs-choice.json";
const GITHUB_REPO = process.env.WWEBJS_GITHUB_REPO || "pedroslopez/whatsapp-web.js";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const REF_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_REFS_PER_TYPE = Number(process.env.WWEBJS_REF_LIST_LIMIT || 100);
const LOG_BACKLOG_LIMIT = 500;
const BUNDLED_DEP_SPEC =
  packageJson.dependencies?.["whatsapp-web.js"] || process.env.WWEBJS_BUILD_REF || "latest";
const APP_BUILD_VERSION = String(process.env.APP_BUILD_VERSION || "").trim();
const IS_DIRTY_BUILD =
  APP_BUILD_VERSION.length > 0 && !/^v?\d+\.\d+\.\d+$/.test(APP_BUILD_VERSION);
const DEFAULT_RUNTIME_NAME = IS_DIRTY_BUILD ? "whatsappur" : "whatsapper";
const DEFAULT_RUNTIME_PORT = IS_DIRTY_BUILD ? 3001 : 3000;
const APP_RUNTIME_NAME = (process.env.APP_RUNTIME_NAME || DEFAULT_RUNTIME_NAME).trim();
const normalizeQrConsoleStyle = (rawStyle) => (rawStyle === "block" ? "block" : "single");
const ACTIVE_QR_CONSOLE_STYLE = normalizeQrConsoleStyle(
  String(process.env.WWEBJS_QR_CONSOLE_STYLE || "single")
    .trim()
    .toLowerCase(),
);

const parseRuntimePort = () => {
  const raw = process.env.APP_PORT;
  if (!raw) {
    return DEFAULT_RUNTIME_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_RUNTIME_PORT;
  }
  return parsed;
};

const APP_RUNTIME_PORT = parseRuntimePort();

const WS_SUPPORTED_EVENTS = Object.freeze([
  "message",
  "ready",
  "qr",
  "disconnected",
  "change_state",
]);

let currentClient = null;
let currentWwebjsModule = null;
let receivedQr = null;
let receivedQrConsole = null;
let receivedQrConsoleSingle = null;
let receivedQrConsoleBlock = null;
let clientInitialized = false;
let currentChoice = "built-in";
let swapInProgress = false;
let refsCache = { fetchedAt: 0, payload: null };
const chatNameCache = new Map();
const CHAT_NAME_CACHE_LIMIT = 500;

const eventSubscribers = new Set();
const runtimeLogSubscribers = new Set();
const runtimeLogBacklog = [];

const sanitizeLogValue = (value) => String(value).replace(/\s+/g, " ").trim();

const formatLogDetails = (details) => {
  if (!details || typeof details !== "object") {
    return "";
  }
  const parts = [];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "object") {
      parts.push(`${key}=[complex]`);
      continue;
    }
    parts.push(`${key}=${sanitizeLogValue(value)}`);
  }
  return parts.join(" ");
};

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

const emitRuntimeLog = (level, message, details = {}) => {
  const entry = {
    type: "log",
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  };

  const detailsText = formatLogDetails(details);
  const printable = detailsText
    ? `[${entry.timestamp}] [${level}] ${message} | ${detailsText}`
    : `[${entry.timestamp}] [${level}] ${message}`;
  console.log(printable);

  runtimeLogBacklog.push(entry);
  if (runtimeLogBacklog.length > LOG_BACKLOG_LIMIT) {
    runtimeLogBacklog.shift();
  }

  for (const callback of runtimeLogSubscribers) {
    try {
      callback(entry);
    } catch (error) {
      console.error("Failed to dispatch runtime log event", error);
    }
  }
};

const normalizeChoice = (choiceObject) =>
  choiceObject.type === "built-in"
    ? "built-in"
    : `${choiceObject.type}:${choiceObject.ref}`;

const parseChoice = (rawChoice) => {
  if (rawChoice === "built-in") {
    return { type: "built-in", ref: null };
  }

  if (typeof rawChoice !== "string") {
    throw new Error("Choice must be a string");
  }

  const match = /^(tag|branch):([A-Za-z0-9._/-]+)$/.exec(rawChoice.trim());
  if (!match) {
    throw new Error("Invalid choice format. Expected built-in, tag:<name>, or branch:<name>");
  }

  return { type: match[1], ref: match[2] };
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

const normalizeChatName = (value) => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
};

const cacheChatName = (chatId, chatName) => {
  if (!chatId || !chatName) {
    return;
  }
  if (!chatNameCache.has(chatId) && chatNameCache.size >= CHAT_NAME_CACHE_LIMIT) {
    const firstKey = chatNameCache.keys().next().value;
    if (firstKey) {
      chatNameCache.delete(firstKey);
    }
  }
  chatNameCache.set(chatId, chatName);
};

const resolveChatName = async (message, chatId) => {
  if (!chatId) {
    return null;
  }

  const cachedName = normalizeChatName(chatNameCache.get(chatId));
  if (cachedName) {
    return cachedName;
  }

  const hintedName = normalizeChatName(
    message?._data?.chat?.name || message?._data?.chat?.formattedTitle,
  );
  if (hintedName) {
    cacheChatName(chatId, hintedName);
    return hintedName;
  }

  try {
    if (typeof message?.getChat === "function") {
      const chat = await message.getChat();
      const resolvedName = normalizeChatName(chat?.name || chat?.formattedTitle);
      if (resolvedName) {
        cacheChatName(chatId, resolvedName);
        return resolvedName;
      }
    }
  } catch (_) {
    // Ignore lookup errors and continue without chat name.
  }

  return null;
};

const emitMessageEvent = async (message, { includeFromMe }) => {
  try {
    const payload = serializeMessage(message);
    if (payload.fromMe !== includeFromMe) {
      return;
    }

    const chatName = await resolveChatName(message, payload.chatId);
    if (chatName) {
      payload.chatName = chatName;
    }

    emitEvent("message", payload);
  } catch (error) {
    emitRuntimeLog("warn", "Failed to process message event", {
      error: String(error?.message || error),
    });
  }
};

const renderQrConsole = (qrPayload, { darkCell, lightCell }) => {
  if (!qrPayload) {
    return null;
  }

  try {
    const model = new QRCodeModel(-1, QRErrorCorrectLevel.L);
    model.addData(qrPayload);
    model.make();

    const width = model.getModuleCount();
    const horizontalBorder = lightCell.repeat(width + 2);
    let rendered = `${horizontalBorder}\n`;

    for (const row of model.modules) {
      rendered += lightCell;
      rendered += row.map((isBlack) => (isBlack ? darkCell : lightCell)).join("");
      rendered += `${lightCell}\n`;
    }
    rendered += horizontalBorder;
    return rendered;
  } catch (_) {
    return null;
  }
};

const getActiveQrConsole = (singleStyle, blockStyle) =>
  ACTIVE_QR_CONSOLE_STYLE === "block" ? blockStyle : singleStyle;

const clearWwebjsRequireCache = () => {
  const pattern = /node_modules[\\/]+whatsapp-web\.js[\\/]/;
  for (const cacheKey of Object.keys(require.cache)) {
    if (pattern.test(cacheKey)) {
      delete require.cache[cacheKey];
    }
  }

  try {
    delete require.cache[require.resolve("whatsapp-web.js")];
  } catch (_) {
    // Ignore if it was not loaded.
  }
  try {
    delete require.cache[require.resolve("whatsapp-web.js/package.json")];
  } catch (_) {
    // Ignore if it was not loaded.
  }
};

const getInstalledVersion = () => {
  try {
    delete require.cache[require.resolve("whatsapp-web.js/package.json")];
    return require("whatsapp-web.js/package.json").version || "unknown";
  } catch (_) {
    return "unknown";
  }
};

const ensureModuleLoaded = () => {
  if (!currentWwebjsModule) {
    clearWwebjsRequireCache();
    currentWwebjsModule = require("whatsapp-web.js");
  }
  return currentWwebjsModule;
};

const createClient = () => {
  const { Client, LocalAuth } = ensureModuleLoaded();
  return new Client({
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
};

const bindClientEvents = (client) => {
  client.on("qr", (qr) => {
    const qrConsoleSingle = renderQrConsole(qr, { darkCell: "#", lightCell: " " });
    const qrConsoleBlock = renderQrConsole(qr, { darkCell: "##", lightCell: "  " });
    const qrConsole = getActiveQrConsole(qrConsoleSingle, qrConsoleBlock);
    emitRuntimeLog("info", "QR received");
    receivedQr = qr;
    receivedQrConsole = qrConsole;
    receivedQrConsoleSingle = qrConsoleSingle;
    receivedQrConsoleBlock = qrConsoleBlock;
    emitEvent("qr", {
      qr,
      qrConsole,
      qrConsoleSingle,
      qrConsoleBlock,
      qrConsoleStyle: ACTIVE_QR_CONSOLE_STYLE,
    });
  });

  client.on("ready", () => {
    clientInitialized = true;
    receivedQr = null;
    receivedQrConsole = null;
    receivedQrConsoleSingle = null;
    receivedQrConsoleBlock = null;
    emitRuntimeLog("info", "Client is ready");
    emitEvent("ready", { initialized: true });
  });

  client.on("disconnected", (reason) => {
    clientInitialized = false;
    receivedQr = null;
    receivedQrConsole = null;
    receivedQrConsoleSingle = null;
    receivedQrConsoleBlock = null;
    emitRuntimeLog("warn", "Client disconnected", { reason: reason || "UNKNOWN" });
    emitEvent("disconnected", { reason: reason || "UNKNOWN" });
  });

  client.on("change_state", (state) => {
    emitRuntimeLog("info", "Client state changed", { state });
    emitEvent("change_state", { state });
  });

  // Keep a single outbound envelope type ("message"), but source it from
  // different wwebjs events to include both inbound and self-sent messages.
  client.on("message", (message) => {
    void emitMessageEvent(message, { includeFromMe: false });
  });

  client.on("message_create", (message) => {
    void emitMessageEvent(message, { includeFromMe: true });
  });
};

const initializeClient = () => {
  const activeVersion = getInstalledVersion();
  emitRuntimeLog("info", "Initializing WhatsApp client", { whatsappWebJsVersion: activeVersion });

  currentClient = createClient();
  bindClientEvents(currentClient);
  currentClient.initialize();
};

const destroyClient = async () => {
  if (!currentClient) {
    return;
  }

  const clientToDestroy = currentClient;
  currentClient = null;
  clientInitialized = false;
  receivedQr = null;
  receivedQrConsole = null;
  receivedQrConsoleSingle = null;
  receivedQrConsoleBlock = null;

  try {
    await clientToDestroy.destroy();
    emitRuntimeLog("info", "Existing WhatsApp client destroyed");
  } catch (error) {
    emitRuntimeLog("warn", "Destroying existing client failed", {
      error: String(error?.message || error),
    });
  }
};

const runNpmInstall = (installSpec) =>
  new Promise((resolve, reject) => {
    emitRuntimeLog("info", `Running npm install for ${installSpec}`);

    const child = spawn("npm", ["install", "--no-save", installSpec], {
      cwd: APP_ROOT,
      env: process.env,
    });

    const emitLines = (level, chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          emitRuntimeLog(level, trimmed);
        }
      }
    };

    child.stdout.on("data", (chunk) => emitLines("info", chunk));
    child.stderr.on("data", (chunk) => emitLines("warn", chunk));

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm install exited with code ${code}`));
    });
  });

const persistChoice = async (choice) => {
  const payload = { choice, savedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(PERSISTED_CHOICE_PATH), { recursive: true });
  await fs.writeFile(PERSISTED_CHOICE_PATH, JSON.stringify(payload, null, 2), "utf8");
};

const loadPersistedChoice = async () => {
  try {
    const raw = await fs.readFile(PERSISTED_CHOICE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const choice = typeof parsed.choice === "string" ? parsed.choice : "built-in";
    parseChoice(choice);
    return choice;
  } catch (_) {
    return "built-in";
  }
};

const choiceToInstallSpec = (choiceObject) => {
  if (choiceObject.type === "built-in") {
    return `whatsapp-web.js@${BUNDLED_DEP_SPEC}`;
  }

  return `github:${GITHUB_REPO}#${choiceObject.ref}`;
};

const getRuntimeState = () => ({
  swapping: swapInProgress,
  initialized: clientInitialized,
  currentChoice,
  bundledDependencySpec: BUNDLED_DEP_SPEC,
  installedVersion: getInstalledVersion(),
  appBuildVersion: APP_BUILD_VERSION || packageJson.version || "unknown",
  appName: APP_RUNTIME_NAME,
  appPort: APP_RUNTIME_PORT,
  dirtyBuild: IS_DIRTY_BUILD,
});

const getRuntimeIdentity = () => ({
  appName: APP_RUNTIME_NAME,
  appPort: APP_RUNTIME_PORT,
  dirtyBuild: IS_DIRTY_BUILD,
});

const mapWithConcurrency = async (items, maxConcurrency, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
};

const githubHeaders = () => {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "whatsapper-runtime",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
};

const fetchGithubJson = async (url) => {
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
  }
  return response.json();
};

const fetchCommitDate = async (sha) => {
  try {
    const payload = await fetchGithubJson(`${GITHUB_API_BASE}/commits/${sha}`);
    return payload?.commit?.committer?.date || payload?.commit?.author?.date || null;
  } catch (_) {
    return null;
  }
};

const listGithubRefs = async ({ refresh = false } = {}) => {
  const now = Date.now();
  if (!refresh && refsCache.payload && now - refsCache.fetchedAt < REF_CACHE_TTL_MS) {
    return refsCache.payload;
  }

  const [tagsRaw, branchesRaw] = await Promise.all([
    fetchGithubJson(`${GITHUB_API_BASE}/tags?per_page=${MAX_REFS_PER_TYPE}`),
    fetchGithubJson(`${GITHUB_API_BASE}/branches?per_page=${MAX_REFS_PER_TYPE}`),
  ]);

  const refs = [];
  for (const tag of tagsRaw || []) {
    if (tag?.name && tag?.commit?.sha) {
      refs.push({ type: "tag", ref: tag.name, sha: tag.commit.sha });
    }
  }
  for (const branch of branchesRaw || []) {
    if (branch?.name && branch?.commit?.sha) {
      refs.push({ type: "branch", ref: branch.name, sha: branch.commit.sha });
    }
  }

  const uniqueShas = [...new Set(refs.map((entry) => entry.sha))];
  const commitDates = {};
  const commitDateResults = await mapWithConcurrency(uniqueShas, 8, async (sha) => ({
    sha,
    date: await fetchCommitDate(sha),
  }));
  for (const { sha, date } of commitDateResults) {
    commitDates[sha] = date;
  }

  const enrichedRefs = refs
    .map((entry) => ({
      ...entry,
      choice: `${entry.type}:${entry.ref}`,
      updatedAt: commitDates[entry.sha] || null,
      label: entry.ref,
    }))
    .sort((a, b) => {
      const aDate = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bDate = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bDate - aDate;
    });

  const payload = {
    builtIn: {
      choice: "built-in",
      type: "built-in",
      label: `Built-in (${getInstalledVersion()})`,
      marked: true,
      updatedAt: null,
    },
    refs: enrichedRefs,
    fetchedAt: new Date().toISOString(),
  };

  refsCache = { fetchedAt: now, payload };
  return payload;
};

const swapToChoice = async (rawChoice, { persist = true, reason = "runtime" } = {}) => {
  if (swapInProgress) {
    throw new Error("A hotswap operation is already in progress");
  }

  const choiceObject = parseChoice(rawChoice);
  const normalizedChoice = normalizeChoice(choiceObject);

  if (normalizedChoice === currentChoice) {
    emitRuntimeLog("info", "Requested choice is already active", { choice: normalizedChoice });
    return getRuntimeState();
  }

  swapInProgress = true;
  emitRuntimeLog("info", "Starting whatsapp-web.js hotswap", {
    choice: normalizedChoice,
    reason,
  });

  try {
    const installSpec = choiceToInstallSpec(choiceObject);
    await runNpmInstall(installSpec);

    await destroyClient();
    currentWwebjsModule = null;
    clearWwebjsRequireCache();
    ensureModuleLoaded();
    initializeClient();

    currentChoice = normalizedChoice;
    if (persist) {
      await persistChoice(currentChoice);
    }

    emitRuntimeLog("info", "Hotswap complete", {
      choice: currentChoice,
      installedVersion: getInstalledVersion(),
    });
    return getRuntimeState();
  } catch (error) {
    emitRuntimeLog("error", "Hotswap failed", {
      choice: normalizedChoice,
      error: String(error?.message || error),
    });

    if (!currentClient) {
      try {
        currentWwebjsModule = null;
        clearWwebjsRequireCache();
        ensureModuleLoaded();
        initializeClient();
      } catch (recoveryError) {
        emitRuntimeLog("error", "Client recovery failed after hotswap failure", {
          error: String(recoveryError?.message || recoveryError),
        });
      }
    }
    throw error;
  } finally {
    swapInProgress = false;
  }
};

const subscribeToEvents = (callback) => {
  eventSubscribers.add(callback);
  return () => eventSubscribers.delete(callback);
};

const subscribeToRuntimeLogs = (callback) => {
  runtimeLogSubscribers.add(callback);
  return () => runtimeLogSubscribers.delete(callback);
};

const startupPromise = (async () => {
  const installedAtBoot = getInstalledVersion();
  emitRuntimeLog("info", "Whatsapper runtime bootstrap started", {
    bundledDependencySpec: BUNDLED_DEP_SPEC,
    installedVersion: installedAtBoot,
    appName: APP_RUNTIME_NAME,
    appPort: APP_RUNTIME_PORT,
    dirtyBuild: IS_DIRTY_BUILD,
  });

  const persistedChoice = await loadPersistedChoice();
  if (persistedChoice !== "built-in") {
    emitRuntimeLog("info", "Applying persisted whatsapp-web.js choice", {
      choice: persistedChoice,
    });
    try {
      await swapToChoice(persistedChoice, { persist: false, reason: "startup" });
      return;
    } catch (_) {
      emitRuntimeLog("warn", "Persisted choice could not be applied, falling back to built-in");
    }
  }

  currentChoice = "built-in";
  ensureModuleLoaded();
  initializeClient();
  await persistChoice("built-in");
})().catch((error) => {
  emitRuntimeLog("error", "Startup bootstrap failed", {
    error: String(error?.message || error),
  });
});

module.exports = {
  WS_SUPPORTED_EVENTS,
  getClient: () => currentClient,
  getMessageMediaClass: () => ensureModuleLoaded().MessageMedia,
  getRuntimeIdentity,
  getQr: () => receivedQr,
  getQrConsole: () => receivedQrConsole,
  getQrConsoleSingle: () => receivedQrConsoleSingle,
  getQrConsoleBlock: () => receivedQrConsoleBlock,
  getQrConsoleStyle: () => ACTIVE_QR_CONSOLE_STYLE,
  isInitialized: () => clientInitialized,
  subscribeToEvents,
  subscribeToRuntimeLogs,
  getRuntimeLogs: () => [...runtimeLogBacklog],
  writeRuntimeLog: emitRuntimeLog,
  getRuntimeState,
  listGithubRefs,
  swapToChoice,
  getStartupPromise: () => startupPromise,
};

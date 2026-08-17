"use strict";

const DEFAULT_GITHUB_REPO = process.env.WWEBJS_GITHUB_REPO || "pedroslopez/whatsapp-web.js";

const SIMPLE_CHOICE_RE = /^(tag|branch):([A-Za-z0-9._/-]+)$/;
const GITHUB_SPEC_RE = /^github:([^/#\s]+\/[^/#\s]+?)(?:\.git)?(?:#(.+))?$/i;
const OWNER_REPO_RE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/;

const parseGithubRepoPath = (pathname) => {
  const parts = String(pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0];
  const repo = String(parts[1] || "").replace(/\.git$/i, "");
  if (!owner || !repo) {
    return null;
  }

  const rest = parts.slice(2);
  let ref = null;
  if (rest[0] === "tree" && rest.length >= 2) {
    ref = rest.slice(1).join("/");
  } else if (rest[0] === "blob" && rest.length >= 2) {
    ref = rest[1];
  } else if (rest[0] === "commit" && rest[1]) {
    ref = rest[1];
  } else if (rest[0] === "releases" && rest[1] === "tag" && rest[2]) {
    ref = rest.slice(2).join("/");
  }

  return { owner, repo, ref };
};

const parseGithubUrl = (rawValue) => {
  let url;
  try {
    url = new URL(String(rawValue || "").trim());
  } catch (_) {
    return null;
  }

  const host = String(url.hostname || "").toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }

  const parsed = parseGithubRepoPath(url.pathname);
  if (!parsed) {
    return null;
  }

  const hashRef = url.hash ? url.hash.replace(/^#/, "").trim() : "";
  return {
    type: "github",
    repo: `${parsed.owner}/${parsed.repo}`,
    ref: parsed.ref || hashRef || null,
  };
};

const parseChoice = (rawChoice) => {
  if (rawChoice === "built-in") {
    return { type: "built-in", ref: null, repo: null };
  }

  if (typeof rawChoice !== "string") {
    throw new Error("Choice must be a string");
  }

  const trimmed = rawChoice.trim();
  if (!trimmed) {
    throw new Error(
      "Invalid choice format. Expected built-in, tag:<name>, branch:<name>, or a GitHub repo URL",
    );
  }

  const simple = SIMPLE_CHOICE_RE.exec(trimmed);
  if (simple) {
    return { type: simple[1], ref: simple[2], repo: null };
  }

  const githubSpec = GITHUB_SPEC_RE.exec(trimmed);
  if (githubSpec) {
    return {
      type: "github",
      repo: githubSpec[1],
      ref: githubSpec[2] || null,
    };
  }

  const fromUrl = parseGithubUrl(trimmed);
  if (fromUrl) {
    return fromUrl;
  }

  if (/^(?:www\.)?github\.com\//i.test(trimmed)) {
    const fromBareHost = parseGithubUrl(`https://${trimmed}`);
    if (fromBareHost) {
      return fromBareHost;
    }
  }

  const ownerRepo = OWNER_REPO_RE.exec(trimmed);
  if (ownerRepo && trimmed.includes("/")) {
    return {
      type: "github",
      repo: ownerRepo[1],
      ref: ownerRepo[2] || null,
    };
  }

  throw new Error(
    "Invalid choice format. Expected built-in, tag:<name>, branch:<name>, or a GitHub repo URL",
  );
};

const normalizeChoice = (choiceObject) => {
  if (choiceObject.type === "built-in") {
    return "built-in";
  }
  if (choiceObject.type === "github") {
    return choiceObject.ref
      ? `github:${choiceObject.repo}#${choiceObject.ref}`
      : `github:${choiceObject.repo}`;
  }
  return `${choiceObject.type}:${choiceObject.ref}`;
};

const choiceToInstallSpec = (
  choiceObject,
  { bundledDepSpec, defaultRepo = DEFAULT_GITHUB_REPO } = {},
) => {
  if (choiceObject.type === "built-in") {
    return `whatsapp-web.js@${bundledDepSpec}`;
  }
  if (choiceObject.type === "github") {
    return choiceObject.ref
      ? `github:${choiceObject.repo}#${choiceObject.ref}`
      : `github:${choiceObject.repo}`;
  }
  return `github:${defaultRepo}#${choiceObject.ref}`;
};

const choiceToGithubUrl = (choiceObject) => {
  if (!choiceObject || choiceObject.type === "built-in") {
    return "";
  }
  if (choiceObject.type === "github") {
    return choiceObject.ref
      ? `https://github.com/${choiceObject.repo}/tree/${choiceObject.ref}`
      : `https://github.com/${choiceObject.repo}`;
  }
  return "";
};

const formatDateTimeStamp = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

module.exports = {
  DEFAULT_GITHUB_REPO,
  parseChoice,
  parseGithubUrl,
  normalizeChoice,
  choiceToInstallSpec,
  choiceToGithubUrl,
  formatDateTimeStamp,
};

"use strict";

const assert = require("assert");
const {
  parseChoice,
  normalizeChoice,
  choiceToInstallSpec,
  choiceToGithubUrl,
  formatDateTimeStamp,
} = require("../app/wwebjsChoice");

const expectChoice = (raw, expected) => {
  const parsed = parseChoice(raw);
  assert.deepStrictEqual(parsed, expected);
  return parsed;
};

expectChoice("built-in", { type: "built-in", ref: null, repo: null });
expectChoice("branch:stealth", { type: "branch", ref: "stealth", repo: null });
expectChoice("tag:v1.2.3", { type: "tag", ref: "v1.2.3", repo: null });

expectChoice("https://github.com/wwebjs/whatsapp-web.js/tree/stealth", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "stealth",
});

expectChoice("https://github.com/wwebjs/whatsapp-web.js/tree/stealth/", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "stealth",
});

expectChoice("https://www.github.com/wwebjs/whatsapp-web.js/tree/feat/foo", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "feat/foo",
});

expectChoice("github.com/wwebjs/whatsapp-web.js/tree/stealth", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "stealth",
});

expectChoice("https://github.com/wwebjs/whatsapp-web.js", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: null,
});

expectChoice("https://github.com/wwebjs/whatsapp-web.js.git", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: null,
});

expectChoice("https://github.com/wwebjs/whatsapp-web.js/commit/abc123def", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "abc123def",
});

expectChoice("https://github.com/wwebjs/whatsapp-web.js/releases/tag/v1.2.3", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "v1.2.3",
});

expectChoice("github:wwebjs/whatsapp-web.js#stealth", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "stealth",
});

expectChoice("wwebjs/whatsapp-web.js#stealth", {
  type: "github",
  repo: "wwebjs/whatsapp-web.js",
  ref: "stealth",
});

const githubChoice = parseChoice("https://github.com/wwebjs/whatsapp-web.js/tree/stealth");
assert.strictEqual(normalizeChoice(githubChoice), "github:wwebjs/whatsapp-web.js#stealth");
assert.strictEqual(
  choiceToInstallSpec(githubChoice, { bundledDepSpec: "1.34.6" }),
  "github:wwebjs/whatsapp-web.js#stealth",
);
assert.strictEqual(
  choiceToGithubUrl(githubChoice),
  "https://github.com/wwebjs/whatsapp-web.js/tree/stealth",
);

assert.strictEqual(
  choiceToInstallSpec(parseChoice("branch:main"), {
    bundledDepSpec: "1.34.6",
    defaultRepo: "pedroslopez/whatsapp-web.js",
  }),
  "github:pedroslopez/whatsapp-web.js#main",
);

assert.strictEqual(
  choiceToInstallSpec(parseChoice("built-in"), { bundledDepSpec: "1.34.6" }),
  "whatsapp-web.js@1.34.6",
);

assert.throws(() => parseChoice("not-a-choice"), /Invalid choice format/);
assert.throws(() => parseChoice("https://gitlab.com/foo/bar"), /Invalid choice format/);
assert.throws(() => parseChoice(123), /Choice must be a string/);

assert.strictEqual(formatDateTimeStamp(new Date(2026, 7, 14, 9, 8, 7)), "2026-08-14 09:08:07");
assert.strictEqual(formatDateTimeStamp("not-a-date"), "unknown");
assert.strictEqual(
  `Seeing results cached from ${formatDateTimeStamp(new Date(2026, 0, 2, 3, 4, 5))}`,
  "Seeing results cached from 2026-01-02 03:04:05",
);

console.log("wwebjsChoice tests passed");

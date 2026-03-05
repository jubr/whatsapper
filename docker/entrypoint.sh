#!/bin/sh
set -eu

APP_BUILD_VERSION_VALUE="${APP_BUILD_VERSION:-}"
IS_DIRTY_BUILD=0
if [ -n "${APP_BUILD_VERSION_VALUE}" ] && ! printf '%s' "${APP_BUILD_VERSION_VALUE}" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$'; then
  IS_DIRTY_BUILD=1
fi

if [ "${IS_DIRTY_BUILD}" -eq 1 ]; then
  APP_RUNTIME_NAME_DEFAULT="whatsappur"
  APP_PORT_DEFAULT="3001"
else
  APP_RUNTIME_NAME_DEFAULT="whatsapper"
  APP_PORT_DEFAULT="3000"
fi

APP_RUNTIME_NAME="${APP_RUNTIME_NAME:-$APP_RUNTIME_NAME_DEFAULT}"
APP_PORT="${APP_PORT:-$APP_PORT_DEFAULT}"
export APP_RUNTIME_NAME APP_PORT

SOURCE_DIR="/workspace/homeassistant/custom_components/whatsapper"
TARGET_ROOT="${HA_CUSTOM_COMPONENTS_PATH:-/homeassistant/custom_components}"
TARGET_DIR="${TARGET_ROOT}/${APP_RUNTIME_NAME}"

if [ ! -d "${SOURCE_DIR}" ]; then
  echo "Bundled Home Assistant integration was not found at ${SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_ROOT}"
rm -rf "${TARGET_DIR}"
cp -R "${SOURCE_DIR}" "${TARGET_DIR}"
if [ "${APP_RUNTIME_NAME}" != "whatsapper" ]; then
  TARGET_DIR="${TARGET_DIR}" node - <<'NODE'
const fs = require("fs");
const path = require("path");

const domain = process.env.APP_RUNTIME_NAME;
const domainTitle = `${domain.charAt(0).toUpperCase()}${domain.slice(1)}`;
const appPort = Number(process.env.APP_PORT);
const defaultHaHostPort = `localhost:${appPort + 1000}`;
const targetDir = process.env.TARGET_DIR;

const TEXT_EXTENSIONS = new Set([
  ".json",
  ".py",
  ".yaml",
  ".yml",
  ".md",
  ".txt",
  ".cfg",
  ".ini",
]);

const walkFiles = (directory) => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
};

const replaceInFile = (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    return false;
  }

  const original = fs.readFileSync(filePath, "utf8");
  let updated = original;
  updated = updated.replace(/Whatsapper/g, domainTitle);
  updated = updated.replace(/whatsapper/g, domain);
  updated = updated.replace(/localhost:4000/g, defaultHaHostPort);

  if (updated === original) {
    return false;
  }

  fs.writeFileSync(filePath, updated, "utf8");
  return true;
};

let changedFiles = 0;
for (const filePath of walkFiles(targetDir)) {
  if (replaceInFile(filePath)) {
    changedFiles += 1;
  }
}

console.log(
  `Dirty rewrite complete for ${targetDir} (domain=${domain}, changedFiles=${changedFiles})`,
);
NODE
fi

echo "Installed Home Assistant integration in ${TARGET_DIR} (name=${APP_RUNTIME_NAME}, port=${APP_PORT})"

exec tini -- node app/server.js

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
TARGET_ROOT="${HA_CUSTOM_COMPONENTS_PATH:-/ha-custom-components}"
TARGET_DIR="${TARGET_ROOT}/${APP_RUNTIME_NAME}"

if [ ! -d "${SOURCE_DIR}" ]; then
  echo "Bundled Home Assistant integration was not found at ${SOURCE_DIR}" >&2
  exit 1
fi

echo "Filesystem snapshot before custom_components copy (find / -maxdepth 2 -ls):"
find / -maxdepth 2 -ls 2>/dev/null || true

mkdir -p "${TARGET_ROOT}"
rm -rf "${TARGET_DIR}"
cp -R "${SOURCE_DIR}" "${TARGET_DIR}"
if [ "${APP_RUNTIME_NAME}" != "whatsapper" ]; then
  TARGET_DIR="${TARGET_DIR}" node - <<'NODE'
const fs = require("fs");
const path = require("path");

const domain = process.env.APP_RUNTIME_NAME;
const appPort = Number(process.env.APP_PORT);
const defaultHaHostPort = `localhost:${appPort + 1000}`;
const targetDir = process.env.TARGET_DIR;

const manifestPath = path.join(targetDir, "manifest.json");
const initPath = path.join(targetDir, "__init__.py");
const notifyPath = path.join(targetDir, "notify.py");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.domain = domain;
manifest.name = `${domain.charAt(0).toUpperCase()}${domain.slice(1)} integration`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");

let initText = fs.readFileSync(initPath, "utf8");
initText = initText.replace('DOMAIN = "whatsapper"', `DOMAIN = "${domain}"`);
initText = initText.replace(
  'MESSAGE_EVENT = "whatsapper_message"',
  `MESSAGE_EVENT = "${domain}_message"`,
);
initText = initText.replace(
  'DEFAULT_HOST_PORT = "localhost:4000"',
  `DEFAULT_HOST_PORT = "${defaultHaHostPort}"`,
);
fs.writeFileSync(initPath, initText, "utf8");

let notifyText = fs.readFileSync(notifyPath, "utf8");
notifyText = notifyText.replace(
  'host_port = "localhost:4000"',
  `host_port = "${defaultHaHostPort}"`,
);
fs.writeFileSync(notifyPath, notifyText, "utf8");
NODE
fi

echo "Installed Home Assistant integration in ${TARGET_DIR} (name=${APP_RUNTIME_NAME}, port=${APP_PORT})"

exec tini -- node app/server.js

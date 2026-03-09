#!/bin/sh
set -eu

SOURCE_DIR="/workspace/homeassistant/custom_components/whatsapper"
TARGET_ROOT="${HA_CUSTOM_COMPONENTS_PATH:-/ha-custom-components}"
TARGET_DIR="${TARGET_ROOT}/whatsapper"

if [ ! -d "${SOURCE_DIR}" ]; then
  echo "Bundled Home Assistant integration was not found at ${SOURCE_DIR}" >&2
  exit 1
fi

mkdir -p "${TARGET_ROOT}"
rm -rf "${TARGET_DIR}"
cp -R "${SOURCE_DIR}" "${TARGET_DIR}"
echo "Installed Home Assistant integration in ${TARGET_DIR}"

exec tini -- node app/server.js

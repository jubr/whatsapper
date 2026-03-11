## Unreleased (2026-02-27)

- Added full ingress-focused UI shell with WhatsApp-styled navigation pages for Chats, Logs, Stats, QR and runtime hotswap.
- Root page now exposes option "chat rows" instead of live chat data, including QR attention badge and pinned app version row.
- Added dedicated `/logs` page with consolidated plain-text runtime/server/WebSocket/RPC stream (same stream also printed to stdout).
- Added `/ws-clients` page and API-backed live statistics for connected WebSocket clients and traffic counters.
- Added runtime `whatsapp-web.js` hotswap page with ref discovery, persisted selection, and WebSocket progress logs.
- Added startup optimization to skip hotswap when persisted tag already matches the installed runtime version.
- Enhanced message events to include both inbound and self-sent message flows and enriched payload with `chat_name`.
- Added Home Assistant notify quote-reply support via `reply_to_message_id` (`quotedMessageId` passthrough).
- Added Home Assistant UI config flow, Supervisor discovery support, host/port auto-detection improvements, and delayed listener bootstrap after HA init.
- Added reconnect version mismatch handling in integration (notify + delayed config entry reload).
- Added local integration brand asset bundle for renamed dirty/dev builds and marked integration as `cloud_push`.
- Added docs/examples for translation automation (Dutch ↔ Portuguese) with loop prevention and chat-name targeting.

## 1.2.0 (2026-02-03)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases/tag/1.2.0)

## 1.1.2 (2026-01-31)
- Now supports arch64 arch

## 1.1.1 (2026-01-01)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases/tag/1.1.1)

## 1.1.0 (2025-12-09)
- Move docker image from docker to github
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases/tag/1.1.0)

## 1.0.5 (2025-11-18)
- Added `env_vars` option to allow passing custom environment variables from the add-on configuration.

## 1.0.4 (2025-09-15)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases)

## 1.0.3 (2025-05-21)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases)

## 1.0.2 (2024-08-04)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases)

## 1.0.1-2 (2024-08-05)
- Minor bugs fixed

## 1.0.1 (2024-07-25)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases)

## 1.0.0 (2024-07-11)
- Update to version 1.0.0 of baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases)

## 2024.1.30 (2024-05-04)
- Update to latest version from baldarn/whatsapper (changelog : https://github.com/baldarn/whatsapper/releases)

## 2024.4.29-2 (2024-04-29)

- Fix WWeb.js library

## 2024.4.29-1 (2024-04-29)

- Fix docker build

## 2024.4.29 (2024-04-29)

- Fix wweb.js client issue (see https://github.com/pedroslopez/whatsapp-web.js/issues/2885)

## 2024.1.30-1 (2024-01-30)

- Fix data persistence

## 2024.1.30 (2024-01-30)

- Updated version
- Add data persistence

## 2024.1.26-1 (2024-01-26)

- Updated version

## 2024.1.26 (2024-01-26)

- Updated version

## 2024.1.22-3 (2024-01-26)

- Minor bugs fixed

## 2024.1.22-2 (2024-01-24)

- Minor bugs fixed

## 2024.1.24 (2024-01-24)

- Fix configs

## 2024.1.22 (2024-01-22)

- Updated version and upstream

## 0.1.1 (2024-01-01)

- Initial build

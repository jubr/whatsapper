# AGENTS.md

Conventions and implementation patterns established in this repository/chat.
Future agents should follow these defaults unless the user explicitly asks otherwise.

## 1) Product/runtime identity

- Two runtime modes:
  - **Stable/clean build**: `whatsapper` on port `3000`
  - **Dev/dirty build**: `whatsappur` on port `3001`
- Dirty/dev language in UI/docs should prefer **"Dev build"** wording.
- Keep stable + dev installable side-by-side (name/port/service/domain separation).

## 2) Versioning and build pipeline

- Release version is computed from git tags/describe (`x.y.z` clean, `x.y.z-N-sha` dirty).
- Docker image naming:
  - clean: `ghcr.io/jubr/ha-app-whatsapper-{arch}`
  - dirty: `ghcr.io/jubr/ha-app-whatsappur-{arch}`
- Before Docker build, CI must sync integration version files to computed release version:
  - `homeassistant/custom_components/whatsapper/manifest.json` (`version`)
  - `homeassistant/custom_components/whatsapper/__init__.py` (`INTEGRATION_RUNTIME_VERSION`)
- Workflow supports `main` and `cursor/**` branches.

## 3) Integration version source of truth (UI)

- Add-on UI must obtain integration version from the HA integration over the **existing events websocket**:
  - Add-on sends `integration_version_request` on `/api/v1/events/ws` connect.
  - HA integration responds with `integration_version_response` containing `domain` + `integrationVersion`.
- Root UI mismatch indicator compares:
  - add-on/app version (runtime/app build version)
  - integration version received through websocket handshake

## 4) Web/API and websocket patterns

- Event exposure endpoint is websocket: `api/v1/events/ws`.
- Websocket RPC is used for integration operations (not REST polling) where possible:
  - `resolve_chat`
  - `send_message`
  - `send_media`
  - `react_message`
- WS traffic and RPC request/response should be logged to stdout in plain text.

## 5) Logging style

- No Fastify JSON logger output (`logger: false`).
- Prefer one consolidated plain-text runtime log stream:
  - stdout + runtime log websocket + `/logs` page.
- Include HTTP, websocket in/out, and RPC activity.
- Avoid raw JSON log blobs in user-facing log stream.

## 6) Home Assistant integration patterns

- Keep custom integration source in this repo under `homeassistant/custom_components/whatsapper`.
- Listener startup should happen after HA init/start (`EVENT_HOMEASSISTANT_STARTED`), not during early bootstrap.
- Auto-load notify platform for UI-configured integration entries.
- Notify service naming should follow domain:
  - stable: `notify.whatsapper`
  - dirty: `notify.whatsappur`
- Host/port autodetect priority:
  - supervisor/runtime config first
  - then localhost candidates
  - no hardcoded direct host fallbacks unless explicitly required.

## 7) Message events and payloads

- Emit/add HA message events for inbound and self-sent messages.
- Include `chat_name` in event payloads.
- Keep event payload mapping stable and close to whatsapp-web.js semantics.

## 8) Notify reaction/send semantics

- `data.reply_to_message_id` is the message reference key.
- Quote-reply for message send uses `quotedMessageId`.
- Reactions:
  - explicit reaction override via `data.reaction_add` (alias `data.reaction`) + `reply_to_message_id`
  - optional `data.reaction_toggle: true` for toggle behavior
  - default reaction behavior is additive/set (non-toggle) unless toggle explicitly requested
- Keep verbose diagnostic logs for route decision (`react_message` vs `send_message`).

## 9) Translation automation blueprint defaults

File: `docs/automation-translate-home-assistant-chat.yaml`

- Uses public Google Translate endpoint via `rest_command.whatsapper_google_translate`.
- Triggered from `whatsapper_message`/`whatsappur_message`, selected by blueprint input `wa_service_name`.
- Uses blueprint input `chat_name` (default `Home Assistant`) instead of hardcoded chat filtering.
- Routing:
  - source language in `language_one` -> target is first code from `language_two`
  - source language in `language_two` -> target is first code from `language_one`
  - defaults: `language_one: "nl,en"`, `language_two: "pt"`
- Confidence gate threshold default: `0.5` (or alphabetic char fallback gate).
- Progress/status reactions:
  - start: busy fish
  - success: replace fish with detected source-language flag (from shortlist map)
  - fail: replace with question icon
- Loop-prevention prefix regex is built dynamically from target/source primary flags + globe (defaults to `^(🇵🇹|🇳🇱|🌐)`).
- Translation message is posted as regular message (not quoted reply).
- Automation should be defensive against missing response variables and service/network failures.

## 10) Ping/pong template safety

- Avoid `regex_findall_index(..., 0)` without guarding; it causes `IndexError`.
- Use safe pattern:
  - `body | default('')`
  - `regex_findall(...) | first | default('')`

## 11) UI/Ingress patterns

- Root page is a WhatsApp-style static options screen (not real chat list data).
- Non-root pages use the fake chat header shell style.
- Keep ghost/non-operable elements extremely dim with tooltip:
  - `just looks good, nothing to do here`
- Root rows include versions and status rows with conditional pin/dot behavior.
- Attention badge is a dot-only indicator (no number).
- Integration version row behavior:
  - show attention dot + subtitle hint when mismatch
  - show pin when no mismatch
  - keep dimmed style consistent with version rows.
- Bottom nav mapping:
  - Chats -> `/chats`
  - Logs -> `/logs`
  - Stats -> `/ws-clients`

## 12) Branding/assets

- Keep add-on assets in repo root:
  - `apparmor.txt`, `icon.png`, `logo.png`, `CHANGELOG.md`
- Keep debug dev add-on assets in `debug/whatsappur/` as needed (`icon.png`, `logo.png`).
- Integration branding should remain consistent with add-on branding.

## 13) Documentation expectations

- Keep docs focused on glue/differences/exceptions relative to upstream whatsapp-web.js.
- Maintain/update:
  - `docs/homeassistant-integration.md`
  - `docs/automation-translate-home-assistant-chat.yaml`
  - `docs/ui-guidelines.md`
  - top-level docs snippets (`DOCS.md`, `README.md`) when examples change.

## 14) Installable software/tooling

- Explicit package-manager install list (`apt`/`apk`) from this chat transcript:
  - **none found in accessible transcript files for this environment**
- Keep this section source-driven:
  - only add packages here when a concrete `apt`/`apt-get`/`apk add` command was actually used
  - do not infer or invent package names
- Practical baseline tooling still expected in CI/runtime:
  - `node` + `npm`
  - `python3`
  - Docker build tooling (Buildx/QEMU in CI workflow)


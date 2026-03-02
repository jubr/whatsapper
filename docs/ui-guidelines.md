# UI Guidelines (Consolidated from chat directives)

This document captures the UI rules requested during this implementation thread.

## 1) General look & feel

- Use a WhatsApp-like visual style and layout.
- Keep the UI ingress-safe (all links/routes should work behind Home Assistant ingress).
- Keep non-operable decorative elements **very light/dim** and clearly non-interactive.
- Non-operable elements must show a delayed tooltip (`~0.5s`) with:
  - `just looks good, nothing to do here`

## 2) Root page behavior

- Root should mimic a WhatsApp chat-list window structure as closely as practical.
- Do **not** render real `getChats()` data on root.
- Render fixed option rows as "chat-like" entries.
- Root title should be runtime name:
  - `Whatsapper` for regular builds
  - `Whatsappur` for dev/dirty builds
- Include top-right `+` and `⋮` visual controls (ghosted/non-operable).
- Keep a realistic search + filter-row appearance (ghosted/non-operable).
- Include at least one pinned row; currently this is the **app version row**.
- Remove legacy root top metadata line:
  - `WhatsApp Web: ... | Runtime port: ...` (must not be shown).

## 3) Root row definitions and ordering

Rows are rendered as fixed options with icons and routes:

1. `Chats` (`💬`) → `/chats`
2. `Logs` (`🧾`) → `/logs`
3. `QR` (`🔐`) → `/qr`
4. `Stats` (`📞`) → `/ws-clients`
5. `Whatsapp-web-js version` (`🧩`) → `/hotswap`
   - Subtitle: `Hotswap runtime version`
   - Right-side meta: current runtime `whatsapp-web.js` version
6. `Whatsapper/Whatsappur version` (`📦`) → no route
   - Must be the **last** row
   - Must be **pinned**
   - Must be dimmed, but only slightly (less dim than ghost controls)

## 4) QR attention behavior

- QR row should show a green unread-like dot only when activation is needed.
- When no activation is needed, QR row appears as normal (no alert dot).

## 5) Bottom navigation

- Keep WhatsApp-like bottom nav structure.
- Required mapping:
  - `Chats` → `/chats`
  - `Logs` (replacing Updates) → `/logs`
  - `Stats` (Calls slot) → `/ws-clients`
- Chats icon in bottom nav must be a **chat bubble** (`💬`).

## 6) Non-root page headers

- Non-root pages should use the fake chat-header pattern with back arrow.
- Header avatar icon must match root-page icon semantics:
  - Chats page header icon: `💬`
  - Logs page header icon: `🧾`
  - QR page header icon: `🔐`
  - Stats page header icon: `📞`
  - Hotswap/runtime page header icon: `🧩`
- Non-root pages should not show root metadata strings (version/port banner).

## 7) QR page specifics

- Keep QR page with normal page content and centered QR image.
- QR image should be viewable directly in UI (not only downloadable text/raw payload).
- QR should refresh/reload when backend QR state changes.
- Do not display raw QR payload text in the UI.
- Do not display ASCII/ANSI QR blocks in UI.

## 8) Typography and sizing

- Keep QR/chats links and primary navigation legible with larger touch-friendly sizing.
- Keep monospaced rendering where explicitly needed (logs/IDs/QR text contexts only).

## 9) Logging UX page rules

- Provide a dedicated top-level `Logs` page.
- Logs page should consume a unified stream (runtime + server + WS + RPC).
- Present logs as human-readable plain text (no JSON blobs in UI stream).


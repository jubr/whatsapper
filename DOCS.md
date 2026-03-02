# Whatsapper Home Assistant app notes

This document intentionally covers only the **glue** between Home Assistant and `whatsapp-web.js`.
For the full WhatsApp API surface, use the upstream docs directly:

- [`Client` API](https://docs.wwebjs.dev/Client.html)
- [`Message` API](https://docs.wwebjs.dev/Message.html)
- [`Chat` API](https://docs.wwebjs.dev/Chat.html)
- [`Contact` API](https://docs.wwebjs.dev/Contact.html)
- [`MessageMedia` API](https://docs.wwebjs.dev/MessageMedia.html)
- [`Client` events (`message`, `message_ack`, etc.)](https://docs.wwebjs.dev/Client.html#event:message)

## What this app adds

1. A websocket event stream endpoint:
   - `ws://<whatsapper-host>/api/v1/events/ws?events=message`
2. Bundled Home Assistant custom integration source:
   - copied to `/homeassistant/custom_components/whatsapper` (through `HA_CUSTOM_COMPONENTS_PATH`)
3. A Home Assistant event bridge:
   - incoming WhatsApp messages become HA events of type `whatsapper_message`
4. A Repairs issue lifecycle for QR:
   - creates `qr_required` with a markdown code block when a new QR is emitted
   - removes the issue automatically when WhatsApp reports `ready`
5. Chat name lookup for notify targets:
   - resolves channel/chat names to `chat_id` via `GET /api/v1/chats?name=...`
6. Runtime hot swap page:
   - `/hotswap` with websocket progress log, connection status, and GitHub refs list

## Differences vs raw `whatsapp-web.js`

- Websocket payloads are plain JSON envelopes, not class instances.
- IDs are serialized strings (`chatId`, `id`) so they can be reused directly in automations.
- For now, the HA bridge consumes `message` events only (message-receive first).
- The integration additionally consumes `qr` and `ready` to manage the Repairs QR issue.

Envelope format:

```json
{
  "eventId": "uuid",
  "event": "message",
  "timestamp": "2026-02-27T20:00:00.000Z",
  "data": {
    "id": "true_12345@c.us_ABCDEF",
    "chatId": "12345@c.us",
    "from": "12345@c.us",
    "to": "99999@c.us",
    "author": null,
    "fromMe": false,
    "body": "whatsapper-ping42",
    "type": "chat",
    "timestamp": 1700000000
  }
}
```

## Home Assistant UI setup (recommended)

Use **Settings -> Devices & Services -> Add Integration -> Whatsapper**.

Fields:

- `host_port` (optional, empty = auto-detect)
- `ws_path` (default `/api/v1/events/ws`)

The entry title reflects the chosen host/port (`Whatsapper (<host:port>)` or `Whatsapper (auto-detect)`).
The add-on also publishes Supervisor discovery, so Home Assistant can trigger a discovered setup flow.
UI config-entry setup auto-loads `notify.whatsapp`.

## Home Assistant `configuration.yaml` (legacy)

```yaml
whatsapper:
  host_port: localhost:3000
  ws_path: /api/v1/events/ws

notify:
  - platform: whatsapper
    name: whatsapp
    host_port: localhost:3000
    # Configure one default:
    # chat_id: 123123123@g.us
    chat_name: Family Group
```

## Ingress QR page

Use `/qr` through ingress or direct access to:

- view the current QR payload in a `<pre><code>` block
- open an external renderer via `qrcode.show`
- see a connected/no-QR-needed status when already linked

## Ingress hot swap page

Use `/hotswap` to switch `whatsapp-web.js` refs at runtime.
The page lists tags/branches sorted by commit datetime (desc), marks built-in, persists selection, and shows progress via websocket logs.

Dirty builds (`x.y.z-N-sha`) default to:

- app name: `whatsappur`
- port: `3001`
- HA integration domain: `whatsappur`

## Example automation: `whatsapper-ping(.*)` -> `whatsapper-pong$1`

This catches incoming pings in any chat/channel and replies in the same target.

```yaml
automation:
  - alias: Whatsapper Ping Pong
    mode: parallel
    trigger:
      - platform: event
        event_type: whatsapper_message
    condition:
      - condition: template
        value_template: "{{ trigger.event.data.body is match('^whatsapper-ping(.*)$') }}"
    variables:
      ping_suffix: "{{ trigger.event.data.body | regex_findall_index('^whatsapper-ping(.*)$', 0) }}"
    action:
      - service: notify.whatsapp
        data:
          target:
            - "{{ trigger.event.data.chat_id }}"
          message: "whatsapper-pong{{ ping_suffix }}"
```

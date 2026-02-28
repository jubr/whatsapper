# Whatsapper x Home Assistant glue documentation

This page documents only the integration layer.  
For the WhatsApp feature set itself, use `whatsapp-web.js` documentation:

- [`Client` class](https://docs.wwebjs.dev/Client.html)
- [`Message` class](https://docs.wwebjs.dev/Message.html)
- [`Chat` class](https://docs.wwebjs.dev/Chat.html)
- [`GroupChat` class](https://docs.wwebjs.dev/GroupChat.html)
- [`Channel` class](https://docs.wwebjs.dev/Channel.html)
- [`MessageMedia` class](https://docs.wwebjs.dev/MessageMedia.html)
- [Event reference (`Client#on`)](https://docs.wwebjs.dev/Client.html#event:message)

## WS-only event API

Incoming events are exposed through websocket only:

```text
GET ws://<host>:3000/api/v1/events/ws?events=message
```

- `events` accepts a comma-separated list.  
- For Home Assistant message-receive flow, use `events=message`.

### Envelope

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
    "body": "hello",
    "type": "chat",
    "timestamp": 1700000000,
    "hasMedia": false
  }
}
```

## HA integration behavior

The bundled custom integration opens the websocket and emits a Home Assistant event:

- `event_type: <domain>_message` (`whatsapper_message` on stable, `whatsappur_message` on dirty builds)
- Creates a Repairs issue (`qr_required`) when WhatsApp emits a `qr` event
- Removes that Repairs issue automatically on `ready`
- Resolves notify targets from chat/channel names to `chat_id` via `/api/v1/chats`

Event payload keys:

- `chat_id` (use this as target for replies)
- `body`
- `from`, `to`, `author`
- `message_id`
- `type`, `timestamp`
- `raw` (original event payload data)

### Repairs QR issue

The integration uses Home Assistant Repairs (`homeassistant.helpers.issue_registry`) to raise a QR login issue when needed.
The repair description includes the QR payload in a markdown fenced code block so it can be copied directly.

When the WhatsApp session connects (`ready`), the issue is auto-deleted.

## Mount strategy (same repo, same deployable)

The container copies integration files from:

```text
/workspace/homeassistant/custom_components/whatsapper
```

to:

```text
${HA_CUSTOM_COMPONENTS_PATH:-/ha-custom-components}/whatsapper
```

In compose, this is shared with Home Assistant as:

```text
/config/custom_components/whatsapper
```

which matches Home Assistant custom integration expectations.

On dirty builds (`x.y.z+N-sha`), the integration is installed as:

```text
/config/custom_components/whatsappur
```

so it can run next to stable `whatsapper`.
Dirty builds also default to app port `3001` (use host mapping `4001:3001` in compose-style setups).

## Runtime library hot swap

The ingress page `/hotswap` can switch the active `whatsapp-web.js` ref at runtime.
It uses websocket logs (`/api/v1/wwebjs/ws`) to show install/reload progress and connection status updates.

Available refs (tags + branches) are fetched from GitHub and sorted by commit datetime descending.
The built-in option is marked and selections are persisted to `/data`, then reapplied on startup.

## `configuration.yaml` (HA)

```yaml
whatsapper:
  host_port: whatsapper:3000
  ws_path: /api/v1/events/ws

notify:
  - platform: whatsapper
    name: whatsapp
    host_port: whatsapper:3000
    # Configure one default:
    # chat_id: 123123123@g.us
    chat_name: Family Group
```

### Target lookup behavior

`notify.whatsapp` accepts:

- `target: ["123123123@g.us"]` (direct ID)
- `target: ["Family Group"]` (resolved by name)

Name resolution calls:

```text
GET /api/v1/chats?name=<target_name>
```

If lookup is ambiguous (multiple matches) the send is aborted and a log error is emitted, so messages are not sent to the wrong chat.

## Example automation: ping -> pong

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

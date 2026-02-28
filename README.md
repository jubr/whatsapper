# Whatsapper

A tiny web api on [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)

## API overview

- `POST /command` (legacy passthrough to `client[command](...params)`)
- `POST /command/media` (legacy helper for `MessageMedia`)
- `GET /api/v1/chats` (JSON chats list + name lookup helper)
- `GET /api/v1/events/ws` (**WebSocket event stream**)
- `GET /hotswap` (runtime `whatsapp-web.js` hot swap UI)

For upstream method and type details, use:

- [Client](https://docs.wwebjs.dev/Client.html)
- [Message](https://docs.wwebjs.dev/Message.html)
- [Chat](https://docs.wwebjs.dev/Chat.html)
- [Contact](https://docs.wwebjs.dev/Contact.html)
- [MessageMedia](https://docs.wwebjs.dev/MessageMedia.html)

## Run

```shell
npm i
node app/server.js
```

## Run with docker compose

`docker compose up`

After startup, a QR code is printed in logs. You can also view the QR payload via `/qr`.
When opened through Home Assistant ingress, the same page shows:

- QR payload in a code block for copy/paste
- direct link to render the QR
- connected/no-QR-needed status when the session is already authenticated
- bundled `whatsapp-web.js` version below the QR/status section

### Build-time quick startup selection

You can bake a ref at image build time (tag or branch) to reduce first-run swap work:

```shell
docker build --build-arg WWEBJS_REF=v1.34.6 -t whatsapper:local .
```

or:

```shell
docker build --build-arg WWEBJS_REF=main -t whatsapper:local .
```

No additional image tagging scheme is required; runtime state is tracked in `/data`.

### Runtime hot swap UI

Open `/hotswap` (ingress-safe page) to:

- browse GitHub tags and branches (sorted by commit datetime descending)
- see built-in choice marked as `built-in`
- switch versions at runtime and persist selection
- watch progress and connection status in a scrolling log div via websocket

## WebSocket events (`/api/v1/events/ws`)

Only websocket is used for incoming events in v1.

Connect with:

```text
ws://<host>:3000/api/v1/events/ws?events=message
```

`events` is a comma-separated list. Supported values currently include:

- `message`
- `ready`
- `qr`
- `disconnected`
- `change_state`

The bundled Home Assistant integration subscribes to `message`, `qr`, and `ready`:

- `message` -> emits `whatsapper_message` in Home Assistant
- `qr` -> creates a Repairs issue with QR payload as a markdown code block
- `ready` -> removes that Repairs issue automatically

Home Assistant notify targets now accept either:

- a `chat_id` (`123123123@g.us`)
- a chat/channel name (`Family Group`)

Name targets are resolved through `GET /api/v1/chats?name=<name>`.

## Legacy command endpoints

Forward any `Client` method:

```json
{
  "command": "sendMessage",
  "params": ["123123123@g.us", "hello"]
}
```

Send media:

```json
{
  "params": ["123123123@g.us", "image/png", "BASE64_DATA", "image.png"]
}
```

## Bundled Home Assistant integration

This image now bundles `custom_components/whatsapper` from:

- this repository (`/homeassistant/custom_components/whatsapper`)

On container startup, the integration is copied to:

- `${HA_CUSTOM_COMPONENTS_PATH:-/ha-custom-components}/whatsapper`

By default, `docker-compose.yaml` mounts a shared named volume (`ha-custom-components`) at `/ha-custom-components`.

## Deploy Whatsapper + Home Assistant from the same compose stack

Start both services with:

```shell
docker compose -f docker-compose.yaml -f docker-compose.homeassistant.yaml up -d
```

This overlay mounts the same `ha-custom-components` volume into Home Assistant at `/config/custom_components`, so HA can load the bundled `whatsapper` integration.
If the integration is not shown on first boot, restart Home Assistant once after the `whatsapper` container is running.

Then configure Home Assistant with the Docker service name as host:

```yaml
whatsapper:
  host_port: whatsapper:3000
  ws_path: /api/v1/events/ws

notify:
  - platform: whatsapper
    name: whatsapp
    host_port: whatsapper:3000
    # Choose one default target:
    # chat_id: 123123123@g.us
    chat_name: Family Group
```

For message-receive automations (`whatsapper_message`) and ping/pong example, see:

- [DOCS.md](./DOCS.md)
- [docs/homeassistant-integration.md](./docs/homeassistant-integration.md)

## Push on docker hub (for me to remember)

`docker buildx build --push --platform linux/amd64 --tag baldarn/whatsapper:TAG --tag baldarn/whatsapper:latest .`

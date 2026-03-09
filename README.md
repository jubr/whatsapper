# Whatsapper

A tiny web api on [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)

## Usage

After run, the QR code for association will be displayed on the console.
Is also possible to get the string version from the path `/qr`

After this, whatsapper is logged and you can forward all `whatsapp-web.js` calls via the `/command` api with this json syntax:

```json
{
  "command" : "cmd",
  "params": ["param1", "param2"],
}
```

this will be forwarded to the whatsapp-web.js and you will get back the return of the lib.

## Special commands

To send media, call with a `POST` via the `/command/media` api with this json syntax:

```json
    "params": ["remote_id to send the media to", "image/png", "29y78y424GWIOJFADIJFADS", "filename.png"],
```

## Run

```shell
npm i
node app/server.js
```

## Run with docker compose

`docker compose up`

## Bundled Home Assistant integration

This image now bundles `custom_components/whatsapper` from:

- https://github.com/jubr/whatsapper-ha-integration

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
notify:
  - platform: whatsapper
    name: whatsapp
    host_port: whatsapper:3000
    chat_id: 123123123@g.us
```

## Push on docker hub (for me to remember)

`docker buildx build --push --platform linux/amd64 --tag baldarn/whatsapper:TAG --tag baldarn/whatsapper:latest .`

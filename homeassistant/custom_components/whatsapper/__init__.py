"""Whatsapper integration entrypoint."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import voluptuous as vol
from aiohttp import WSMsgType
import homeassistant.helpers.config_validation as cv
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

DOMAIN = "whatsapper"
CONF_HOST_PORT = "host_port"
CONF_WS_PATH = "ws_path"
DEFAULT_HOST_PORT = "localhost:4000"
DEFAULT_WS_PATH = "/api/v1/events/ws"
MESSAGE_EVENT = "whatsapper_message"

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Optional(CONF_HOST_PORT, default=DEFAULT_HOST_PORT): cv.string,
                vol.Optional(CONF_WS_PATH, default=DEFAULT_WS_PATH): cv.string,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


def _build_ws_url(host_port: str, ws_path: str) -> str:
    normalized_path = ws_path if ws_path.startswith("/") else f"/{ws_path}"
    return f"ws://{host_port}{normalized_path}?events=message"


def _to_ha_message_event(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data", {})
    return {
        "event_id": payload.get("eventId"),
        "event_timestamp": payload.get("timestamp"),
        "message_id": data.get("id"),
        "chat_id": data.get("chatId"),
        "from": data.get("from"),
        "to": data.get("to"),
        "author": data.get("author"),
        "from_me": data.get("fromMe"),
        "body": data.get("body"),
        "type": data.get("type"),
        "timestamp": data.get("timestamp"),
        "has_media": data.get("hasMedia"),
        "raw": data,
    }


async def _listen_for_messages(hass: HomeAssistant, ws_url: str) -> None:
    backoff = 2
    session = async_get_clientsession(hass)

    while True:
        try:
            async with session.ws_connect(ws_url, heartbeat=30) as websocket:
                _LOGGER.info("Connected to Whatsapper websocket at %s", ws_url)
                backoff = 2

                async for ws_message in websocket:
                    if ws_message.type != WSMsgType.TEXT:
                        if ws_message.type in (WSMsgType.CLOSED, WSMsgType.CLOSE, WSMsgType.ERROR):
                            break
                        continue

                    try:
                        payload = json.loads(ws_message.data)
                    except json.JSONDecodeError:
                        _LOGGER.debug("Ignoring malformed websocket message: %s", ws_message.data)
                        continue

                    if payload.get("event") != "message":
                        continue

                    hass.bus.async_fire(MESSAGE_EVENT, _to_ha_message_event(payload))
        except asyncio.CancelledError:
            raise
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.warning("Whatsapper websocket disconnected: %s", err)

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up Whatsapper integration from YAML."""
    if DOMAIN not in config:
        return True

    conf = config[DOMAIN]
    ws_url = _build_ws_url(conf[CONF_HOST_PORT], conf[CONF_WS_PATH])

    task = hass.async_create_task(_listen_for_messages(hass, ws_url))
    hass.data.setdefault(DOMAIN, {})["listener_task"] = task

    @callback
    def _on_stop(_event) -> None:
        task.cancel()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _on_stop)
    return True


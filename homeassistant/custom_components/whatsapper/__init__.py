"""Whatsapper integration entrypoint."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import quote

import voluptuous as vol
from aiohttp import WSMsgType
import homeassistant.helpers.config_validation as cv
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import issue_registry as ir
from .auto_host_port import async_detect_host_port

_LOGGER = logging.getLogger(__name__)

DOMAIN = "whatsapper"
CONF_HOST_PORT = "host_port"
CONF_WS_PATH = "ws_path"
DEFAULT_WS_PATH = "/api/v1/events/ws"
MESSAGE_EVENT = "whatsapper_message"
WS_EVENTS = ("message", "qr", "ready")
QR_REPAIRS_ISSUE_ID = "qr_required"
QR_REPAIRS_TRANSLATION_KEY = "qr_required"

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Optional(CONF_HOST_PORT): cv.string,
                vol.Optional(CONF_WS_PATH, default=DEFAULT_WS_PATH): cv.string,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


def _build_ws_url(host_port: str, ws_path: str) -> str:
    normalized_path = ws_path if ws_path.startswith("/") else f"/{ws_path}"
    events_query = quote(",".join(WS_EVENTS), safe=",")
    return f"ws://{host_port}{normalized_path}?events={events_query}"


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


def _to_code_block(content: str, language: str = "text") -> str:
    return f"```{language}\n{content}\n```"


def _create_qr_issue(hass: HomeAssistant, qr_payload: str, qr_console: str | None = None) -> None:
    qr_code_block = _to_code_block(qr_payload, "text")
    qr_console_block = _to_code_block(qr_console, "text") if qr_console else "_Not available yet._"
    ir.async_create_issue(
        hass,
        DOMAIN,
        QR_REPAIRS_ISSUE_ID,
        is_fixable=False,
        is_persistent=True,
        severity=ir.IssueSeverity.ERROR,
        translation_key=QR_REPAIRS_TRANSLATION_KEY,
        translation_placeholders={
            "qr_code_block": qr_code_block,
            "qr_console_block": qr_console_block,
        },
    )
    if qr_console:
        _LOGGER.warning("Whatsapper QR console render:\n%s", qr_console)


def _delete_qr_issue(hass: HomeAssistant) -> None:
    ir.async_delete_issue(hass, DOMAIN, QR_REPAIRS_ISSUE_ID)


async def _listen_for_messages(
    hass: HomeAssistant,
    configured_host_port: str | None,
    ws_path: str,
) -> None:
    backoff = 2
    session = async_get_clientsession(hass)

    while True:
        host_port = await async_detect_host_port(
            hass,
            configured_host_port,
            refresh=backoff > 2,
        )
        ws_url = _build_ws_url(host_port, ws_path)
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

                    if payload.get("type") == "connected":
                        connected_data = payload.get("data", {})
                        if connected_data.get("clientInitialized"):
                            _delete_qr_issue(hass)
                        else:
                            current_qr = connected_data.get("currentQr")
                            current_qr_console = connected_data.get("currentQrConsole")
                            if not isinstance(current_qr_console, str):
                                current_qr_console = connected_data.get("currentQrConsoleSingle")
                            if not isinstance(current_qr_console, str):
                                current_qr_console = connected_data.get("currentQrConsoleBlock")
                            if not isinstance(current_qr_console, str):
                                current_qr_console = connected_data.get("currentQrAnsi")
                            if isinstance(current_qr, str) and current_qr:
                                _create_qr_issue(
                                    hass,
                                    current_qr,
                                    current_qr_console if isinstance(current_qr_console, str) else None,
                                )
                        continue

                    event_name = payload.get("event")

                    if event_name == "message":
                        hass.bus.async_fire(MESSAGE_EVENT, _to_ha_message_event(payload))
                        continue

                    if event_name == "qr":
                        qr_payload = payload.get("data", {}).get("qr")
                        qr_console = payload.get("data", {}).get("qrConsole")
                        if not isinstance(qr_console, str):
                            qr_console = payload.get("data", {}).get("qrConsoleSingle")
                        if not isinstance(qr_console, str):
                            qr_console = payload.get("data", {}).get("qrConsoleBlock")
                        if not isinstance(qr_console, str):
                            qr_console = payload.get("data", {}).get("qrAnsi")
                        if isinstance(qr_payload, str) and qr_payload:
                            _create_qr_issue(
                                hass,
                                qr_payload,
                                qr_console if isinstance(qr_console, str) else None,
                            )
                        continue

                    if event_name == "ready":
                        _delete_qr_issue(hass)
                        continue
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
    configured_host_port = conf.get(CONF_HOST_PORT)
    ws_path = conf.get(CONF_WS_PATH, DEFAULT_WS_PATH)
    domain_data = hass.data.setdefault(DOMAIN, {})

    @callback
    def _start_listener(_event=None) -> None:
        listener_task = domain_data.get("listener_task")
        if listener_task and not listener_task.done():
            return
        try:
            task = hass.async_create_background_task(
                _listen_for_messages(hass, configured_host_port, ws_path),
                f"{DOMAIN}_listener_task",
            )
        except AttributeError:
            task = hass.async_create_task(_listen_for_messages(hass, configured_host_port, ws_path))
        domain_data["listener_task"] = task

    @callback
    def _on_stop(_event=None) -> None:
        listener_task = domain_data.get("listener_task")
        if listener_task:
            listener_task.cancel()

    if hass.is_running:
        hass.loop.call_soon(_start_listener)
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start_listener)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _on_stop)
    return True


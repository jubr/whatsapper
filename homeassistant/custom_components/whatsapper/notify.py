"""Whatsapper platform for notify component."""
from __future__ import annotations

import asyncio
import json
import logging
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any
from uuid import uuid4

import voluptuous as vol
from aiohttp import WSMsgType
from homeassistant.components.notify import (
    PLATFORM_SCHEMA,
    BaseNotificationService,
    ATTR_DATA,
    ATTR_TITLE,
    ATTR_TARGET,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType


_LOGGER = logging.getLogger(__name__)

HOST_PORT = "host_port"
CONF_WS_PATH = "ws_path"
CONF_CHAT_ID = "chat_id"
CONF_CHAT_NAME = "chat_name"
ATTR_IMAGE = "image"
ATTR_IMAGE_TYPE = "image_type"
ATTR_IMAGE_NAME = "image_name"
DEFAULT_WS_PATH = "/api/v1/events/ws"


def _validate_platform_config(config):
    if config.get(CONF_CHAT_ID) or config.get(CONF_CHAT_NAME):
        return config
    raise vol.Invalid("Either chat_id or chat_name must be configured")


PLATFORM_SCHEMA = vol.All(
    PLATFORM_SCHEMA.extend(
        {
            vol.Optional(CONF_CHAT_ID): vol.Coerce(str),
            vol.Optional(CONF_CHAT_NAME): vol.Coerce(str),
            vol.Optional(CONF_WS_PATH, default=DEFAULT_WS_PATH): vol.Coerce(str),
        }
    ),
    _validate_platform_config,
)


def get_service(
    hass: HomeAssistant,
    config: ConfigType,
    discovery_info: DiscoveryInfoType | None = None,
) -> WhatsapperNotificationService:
    """Get the Whatsapper notification service."""

    chat_id = config.get(CONF_CHAT_ID)
    chat_name = config.get(CONF_CHAT_NAME)
    host_port = config.get(HOST_PORT)
    ws_path = config.get(CONF_WS_PATH, DEFAULT_WS_PATH)

    if host_port is None:
        host_port = "localhost:4000"

    return WhatsapperNotificationService(hass, chat_id, chat_name, host_port, ws_path)


class WhatsapperNotificationService(BaseNotificationService):
    def __init__(self, hass, chat_id, chat_name, host_port, ws_path):
        """Initialize the service."""
        self.chat_id = chat_id
        self.chat_name = chat_name
        self.host_port = host_port
        self.ws_path = ws_path
        self.hass = hass

    @staticmethod
    def _is_chat_id(value: str | None) -> bool:
        return isinstance(value, str) and "@" in value

    def _build_ws_url(self) -> str:
        normalized_path = self.ws_path if str(self.ws_path).startswith("/") else f"/{self.ws_path}"
        return f"ws://{self.host_port}{normalized_path}?events=message"

    async def _ws_rpc_request(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = str(uuid4())
        ws_url = self._build_ws_url()
        session = async_get_clientsession(self.hass)

        try:
            async with session.ws_connect(ws_url, heartbeat=30) as websocket:
                await websocket.send_json(
                    {
                        "type": "rpc",
                        "requestId": request_id,
                        "action": action,
                        "params": params,
                    }
                )

                while True:
                    ws_message = await asyncio.wait_for(websocket.receive(), timeout=20)

                    if ws_message.type != WSMsgType.TEXT:
                        if ws_message.type in (WSMsgType.CLOSED, WSMsgType.CLOSE, WSMsgType.ERROR):
                            raise RuntimeError(f"WebSocket closed while waiting for RPC '{action}'")
                        continue

                    try:
                        payload = json.loads(ws_message.data)
                    except json.JSONDecodeError:
                        continue

                    if payload.get("type") in ("connected", "pong"):
                        continue

                    if (
                        payload.get("type") == "rpc_result"
                        and payload.get("requestId") == request_id
                    ):
                        if payload.get("ok"):
                            result = payload.get("result")
                            return result if isinstance(result, dict) else {}
                        raise RuntimeError(
                            str(payload.get("error") or f"RPC action '{action}' failed")
                        )
        except Exception as err:  # pylint: disable=broad-except
            raise RuntimeError(f"WebSocket RPC '{action}' failed: {err}") from err

    async def _resolve_chat_id_from_name(self, chat_name: str) -> str | None:
        chat_name = chat_name.strip()
        if not chat_name:
            return None

        try:
            payload = await self._ws_rpc_request("resolve_chat", {"name": chat_name})
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.error("Failed to resolve chat '%s' over websocket: %s", chat_name, err)
            return None

        matches = payload.get("matches")
        if not isinstance(matches, list):
            _LOGGER.error("Chat lookup websocket response was invalid for '%s'", chat_name)
            return None

        if len(matches) == 1 and isinstance(matches[0], dict):
            chat_id = matches[0].get("id")
            if isinstance(chat_id, str) and chat_id:
                return chat_id

        if len(matches) == 0:
            _LOGGER.error("No WhatsApp chat found with name '%s'", chat_name)
            return None

        matched_names = [str(match.get("name", "")) for match in matches if isinstance(match, dict)]
        _LOGGER.error(
            "Chat name '%s' is ambiguous (%s). Use chat_id instead.",
            chat_name,
            ", ".join(matched_names),
        )
        return None

    async def _resolve_chat_id(self, target: str | None) -> str | None:
        if not target:
            return None
        target = target.strip()
        if not target:
            return None
        if self._is_chat_id(target):
            return target
        return await self._resolve_chat_id_from_name(target)

    async def async_send_message(self, message="", **kwargs):
        """Send a message to the target."""
        chat_id = None
        try:
            target = kwargs.get(ATTR_TARGET)
            if isinstance(target, list):
                target_value = target[0] if target else None
            else:
                target_value = target if target else None

            if target_value:
                chat_id = await self._resolve_chat_id(str(target_value))
            elif self.chat_id:
                chat_id = self.chat_id
            elif self.chat_name:
                chat_id = await self._resolve_chat_id_from_name(self.chat_name)

            if not chat_id:
                _LOGGER.error(
                    "Unable to resolve chat target. Configure chat_id/chat_name or pass a target."
                )
                return

            data = kwargs.get(ATTR_DATA)

            if data and all(attr in data for attr in [ATTR_IMAGE, ATTR_IMAGE_TYPE, ATTR_IMAGE_NAME]):
                await self._ws_rpc_request(
                    "send_media",
                    {
                        "chatId": chat_id,
                        "mimeType": data[ATTR_IMAGE_TYPE],
                        "data": data[ATTR_IMAGE],
                        "filename": data[ATTR_IMAGE_NAME],
                    },
                )
                return

            title = kwargs.get(ATTR_TITLE)
            msg = f"{title}\n\n{message}" if title else message
            msg = msg.replace("\\n", "\n")

            await self._ws_rpc_request(
                "send_message",
                {
                    "chatId": chat_id,
                    "message": msg,
                },
            )
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.error("Sending to %s failed: %s", chat_id, err)

    def send_message(self, message="", **kwargs):
        """Send message through websocket RPC."""
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None

        if running_loop is self.hass.loop:
            self.hass.async_create_task(self.async_send_message(message, **kwargs))
            return

        future = asyncio.run_coroutine_threadsafe(
            self.async_send_message(message, **kwargs),
            self.hass.loop,
        )
        try:
            future.result(timeout=30)
        except FutureTimeoutError:
            future.cancel()
            _LOGGER.error("Timed out while sending websocket notification message")
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.error("Websocket notification send failed: %s", err)

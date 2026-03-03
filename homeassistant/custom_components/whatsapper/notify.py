"""Whatsapper platform for notify component."""
from __future__ import annotations

import asyncio
import json
import logging
import unicodedata
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
from .auto_host_port import async_detect_host_port


_LOGGER = logging.getLogger(__name__)

HOST_PORT = "host_port"
CONF_WS_PATH = "ws_path"
CONF_CHAT_ID = "chat_id"
CONF_CHAT_NAME = "chat_name"
ATTR_IMAGE = "image"
ATTR_IMAGE_TYPE = "image_type"
ATTR_IMAGE_NAME = "image_name"
ATTR_REPLY_TO_MESSAGE_ID = "reply_to_message_id"
ATTR_REACTION_TOGGLE = "reaction_toggle"
DEFAULT_WS_PATH = "/api/v1/events/ws"


PLATFORM_SCHEMA = PLATFORM_SCHEMA.extend(
    {
        vol.Optional(CONF_CHAT_ID): vol.Coerce(str),
        vol.Optional(CONF_CHAT_NAME): vol.Coerce(str),
        vol.Optional(CONF_WS_PATH, default=DEFAULT_WS_PATH): vol.Coerce(str),
    }
)


def get_service(
    hass: HomeAssistant,
    config: ConfigType,
    discovery_info: DiscoveryInfoType | None = None,
) -> WhatsapperNotificationService:
    """Get the Whatsapper notification service."""

    merged_config: dict[str, Any] = dict(config or {})
    if isinstance(discovery_info, dict):
        merged_config.update(discovery_info)

    chat_id = merged_config.get(CONF_CHAT_ID)
    chat_name = merged_config.get(CONF_CHAT_NAME)
    host_port = merged_config.get(HOST_PORT)
    ws_path = merged_config.get(CONF_WS_PATH, DEFAULT_WS_PATH)

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

    @staticmethod
    def _to_bool(value: Any, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in ("1", "true", "yes", "on"):
                return True
            if normalized in ("0", "false", "no", "off", ""):
                return False
        return default

    @staticmethod
    def _extract_reaction_candidate(value: str | None) -> str | None:
        """Return an emoji-like candidate suitable for msg.react(), else None."""
        if not isinstance(value, str):
            return None
        candidate = value.strip()
        if not candidate or "\n" in candidate:
            return None
        # Keep reaction-only shortcut strict enough to avoid accidental punctuation reactions.
        if len(candidate) > 8:
            return None

        has_symbol = False
        for char in candidate:
            if char.isspace():
                return None
            category = unicodedata.category(char)
            if category.startswith(("L", "N")):
                return None
            if category.startswith("S") or char in ("\u200d", "\ufe0f"):
                has_symbol = True

        return candidate if has_symbol else None

    async def _get_host_port(self, refresh: bool = False) -> str:
        return await async_detect_host_port(
            self.hass,
            self.host_port,
            refresh=refresh,
        )

    def _build_ws_url_for_host(self, host_port: str) -> str:
        normalized_path = self.ws_path if str(self.ws_path).startswith("/") else f"/{self.ws_path}"
        return f"ws://{host_port}{normalized_path}?events=message"

    async def _ws_rpc_request(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = str(uuid4())
        session = async_get_clientsession(self.hass)
        attempted_hosts: list[str] = []
        errors: list[str] = []

        first_host = await self._get_host_port(refresh=False)
        attempted_hosts.append(first_host)
        if not self.host_port:
            refreshed_host = await self._get_host_port(refresh=True)
            if refreshed_host not in attempted_hosts:
                attempted_hosts.append(refreshed_host)

        for host_port in attempted_hosts:
            ws_url = self._build_ws_url_for_host(host_port)
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
                            if ws_message.type in (
                                WSMsgType.CLOSED,
                                WSMsgType.CLOSE,
                                WSMsgType.ERROR,
                            ):
                                raise RuntimeError(
                                    f"WebSocket closed while waiting for RPC '{action}'"
                                )
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
                errors.append(f"{host_port}: {err}")

        raise RuntimeError(
            f"WebSocket RPC '{action}' failed on all host_port candidates ({'; '.join(errors)})"
        )

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
            data = kwargs.get(ATTR_DATA)
            reply_to_message_id = None
            reaction_toggle = False
            if isinstance(data, dict):
                reply_candidate = data.get(ATTR_REPLY_TO_MESSAGE_ID)
                if isinstance(reply_candidate, str) and reply_candidate.strip():
                    reply_to_message_id = reply_candidate.strip()
                reaction_toggle = self._to_bool(data.get(ATTR_REACTION_TOGGLE), False)

            title = kwargs.get(ATTR_TITLE)
            raw_message = "" if message is None else str(message)
            msg = f"{title}\n\n{raw_message}" if title else raw_message
            msg = msg.replace("\\n", "\n")

            reaction_candidate = self._extract_reaction_candidate(msg)
            # Special behavior:
            # If payload is a single emoji-like reaction and includes reply_to_message_id,
            # perform a reaction call instead of sending a text message.
            # Toggle behavior is opt-in via data.reaction_toggle.
            if reply_to_message_id and reaction_candidate:
                await self._ws_rpc_request(
                    "react_message",
                    {
                        "messageId": reply_to_message_id,
                        "reaction": reaction_candidate,
                        "toggle": reaction_toggle,
                    },
                )
                return

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

            await self._ws_rpc_request(
                "send_message",
                {
                    "chatId": chat_id,
                    "message": msg,
                    **({"quotedMessageId": reply_to_message_id} if reply_to_message_id else {}),
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

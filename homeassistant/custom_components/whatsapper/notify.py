"""Whatsapper platform for notify component."""
from __future__ import annotations

import asyncio
import logging
import unicodedata
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any

import voluptuous as vol
from homeassistant.components.notify import (
    PLATFORM_SCHEMA,
    BaseNotificationService,
    ATTR_DATA,
    ATTR_TITLE,
    ATTR_TARGET,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType
from .rpc import (
    async_resolve_chat_id,
    async_resolve_chat_id_from_name,
    async_ws_rpc_request,
)


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
ATTR_REACTION_ADD = "reaction_add"
ATTR_REACTION = "reaction"
ATTR_EDIT_MESSAGE_ID = "edit_message_id"
ATTR_DELETE_MESSAGE_ID = "delete_message_id"
ATTR_DELETE_FOR_EVERYONE = "delete_for_everyone"
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
    def _extract_message_id(value: Any) -> str | None:
        if isinstance(value, str):
            message_id = value.strip()
            if message_id:
                return message_id
        return None

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

    async def _ws_rpc_request(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        return await async_ws_rpc_request(
            self.hass,
            action=action,
            params=params,
            configured_host_port=self.host_port,
            ws_path=str(self.ws_path),
        )

    async def _resolve_chat_id_from_name(self, chat_name: str) -> str | None:
        try:
            return await async_resolve_chat_id_from_name(
                self.hass,
                chat_name=chat_name,
                configured_host_port=self.host_port,
                ws_path=str(self.ws_path),
            )
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.error("Failed to resolve chat '%s' over websocket: %s", chat_name, err)
            return None

    async def _resolve_chat_id(self, target: str | None) -> str | None:
        if not target:
            return None
        try:
            return await async_resolve_chat_id(
                self.hass,
                target=target,
                configured_host_port=self.host_port,
                ws_path=str(self.ws_path),
            )
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.error("Failed to resolve chat target '%s': %s", target, err)
            return None

    async def async_send_message(self, message="", **kwargs):
        """Send a message to the target."""
        chat_id = None
        try:
            data = kwargs.get(ATTR_DATA)
            reply_to_message_id = None
            edit_message_id = None
            delete_message_id = None
            delete_for_everyone = False
            reaction_toggle = False
            reaction_add = None
            if isinstance(data, dict):
                reply_candidate = data.get(ATTR_REPLY_TO_MESSAGE_ID)
                if isinstance(reply_candidate, str) and reply_candidate.strip():
                    reply_to_message_id = reply_candidate.strip()
                edit_message_id = self._extract_message_id(data.get(ATTR_EDIT_MESSAGE_ID))
                delete_message_id = self._extract_message_id(data.get(ATTR_DELETE_MESSAGE_ID))
                delete_for_everyone = self._to_bool(data.get(ATTR_DELETE_FOR_EVERYONE), False)
                reaction_toggle = self._to_bool(data.get(ATTR_REACTION_TOGGLE), False)
                explicit_reaction = data.get(ATTR_REACTION_ADD)
                if explicit_reaction is None:
                    explicit_reaction = data.get(ATTR_REACTION)
                if explicit_reaction is not None:
                    reaction_add = self._extract_reaction_candidate(str(explicit_reaction))
                    if reaction_add is None:
                        _LOGGER.warning(
                            "Ignoring invalid data.%s value for reaction: %s",
                            ATTR_REACTION_ADD,
                            explicit_reaction,
                        )

            if not reply_to_message_id:
                top_level_reply = kwargs.get(ATTR_REPLY_TO_MESSAGE_ID)
                if isinstance(top_level_reply, str) and top_level_reply.strip():
                    reply_to_message_id = top_level_reply.strip()

            if not edit_message_id:
                edit_message_id = self._extract_message_id(kwargs.get(ATTR_EDIT_MESSAGE_ID))
            if not delete_message_id:
                delete_message_id = self._extract_message_id(kwargs.get(ATTR_DELETE_MESSAGE_ID))
            if not delete_for_everyone:
                delete_for_everyone = self._to_bool(kwargs.get(ATTR_DELETE_FOR_EVERYONE), False)

            if reaction_add is None:
                top_level_reaction = kwargs.get(ATTR_REACTION_ADD)
                if top_level_reaction is None:
                    top_level_reaction = kwargs.get(ATTR_REACTION)
                if top_level_reaction is not None:
                    reaction_add = self._extract_reaction_candidate(str(top_level_reaction))
                    if reaction_add is None:
                        _LOGGER.warning(
                            "Ignoring invalid top-level reaction override value: %s",
                            top_level_reaction,
                        )

            if not reaction_toggle:
                reaction_toggle = self._to_bool(kwargs.get(ATTR_REACTION_TOGGLE), False)

            title = kwargs.get(ATTR_TITLE)
            raw_message = "" if message is None else str(message)
            msg = f"{title}\n\n{raw_message}" if title else raw_message
            msg = msg.replace("\\n", "\n")

            reaction_candidate = reaction_add or self._extract_reaction_candidate(msg)
            _LOGGER.info(
                "Notify payload parsed | has_data=%s reply_to=%s reaction_add=%s message_trim_len=%d toggle=%s",
                isinstance(data, dict),
                bool(reply_to_message_id),
                reaction_candidate,
                len(msg.strip()),
                reaction_toggle,
            )
            if edit_message_id:
                if not msg.strip():
                    _LOGGER.warning(
                        "Notify route: edit_message skipped because message content is empty | message_id=%s",
                        edit_message_id,
                    )
                    return
                _LOGGER.info(
                    "Notify route: edit_message | message_id=%s message_len=%d",
                    edit_message_id,
                    len(msg),
                )
                await self._ws_rpc_request(
                    "edit_message",
                    {
                        "messageId": edit_message_id,
                        "message": msg,
                    },
                )
                return

            if delete_message_id:
                _LOGGER.info(
                    "Notify route: delete_message | message_id=%s everyone=%s",
                    delete_message_id,
                    delete_for_everyone,
                )
                await self._ws_rpc_request(
                    "delete_message",
                    {
                        "messageId": delete_message_id,
                        "everyone": delete_for_everyone,
                    },
                )
                return

            # Special behavior:
            # If explicit data.reaction_add is provided, or payload is a single
            # emoji-like reaction, and includes reply_to_message_id,
            # perform a reaction call instead of sending a text message.
            # Toggle behavior is opt-in via data.reaction_toggle.
            if reply_to_message_id and reaction_candidate:
                _LOGGER.info(
                    "Notify route: react_message | message_id=%s reaction=%s toggle=%s",
                    reply_to_message_id,
                    reaction_candidate,
                    reaction_toggle,
                )
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
                _LOGGER.info("Notify route: send_media | chat_id=%s", chat_id)
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

            _LOGGER.info(
                "Notify route: send_message | chat_id=%s quoted=%s message_len=%d",
                chat_id,
                bool(reply_to_message_id),
                len(msg),
            )
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

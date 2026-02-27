"""Whatsapper platform for notify component."""
from __future__ import annotations

import logging

import voluptuous as vol
import requests
from requests import RequestException
from homeassistant.components.notify import (
    PLATFORM_SCHEMA,
    BaseNotificationService,
    ATTR_DATA,
    ATTR_TITLE,
    ATTR_TARGET,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType


_LOGGER = logging.getLogger(__name__)

HOST_PORT = "host_port"
CONF_CHAT_ID = "chat_id"
CONF_CHAT_NAME = "chat_name"
ATTR_IMAGE = "image"
ATTR_IMAGE_TYPE = "image_type"
ATTR_IMAGE_NAME = "image_name"


def _validate_platform_config(config):
    if config.get(CONF_CHAT_ID) or config.get(CONF_CHAT_NAME):
        return config
    raise vol.Invalid("Either chat_id or chat_name must be configured")


PLATFORM_SCHEMA = vol.All(
    PLATFORM_SCHEMA.extend(
        {
            vol.Optional(CONF_CHAT_ID): vol.Coerce(str),
            vol.Optional(CONF_CHAT_NAME): vol.Coerce(str),
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

    if host_port is None:
        host_port = "localhost:4000"

    return WhatsapperNotificationService(hass, chat_id, chat_name, host_port)


class WhatsapperNotificationService(BaseNotificationService):
    def __init__(self, hass, chat_id, chat_name, host_port):
        """Initialize the service."""
        self.chat_id = chat_id
        self.chat_name = chat_name
        self.host_port = host_port
        self.hass = hass

    @staticmethod
    def _is_chat_id(value: str | None) -> bool:
        return isinstance(value, str) and "@" in value

    def _resolve_chat_id_from_name(self, chat_name: str) -> str | None:
        chat_name = chat_name.strip()
        if not chat_name:
            return None
        url = f"http://{self.host_port}/api/v1/chats"
        try:
            response = requests.get(url, params={"name": chat_name}, timeout=15)
            response.raise_for_status()
            payload = response.json()
        except RequestException as err:
            _LOGGER.error("Failed to query chat lookup API for '%s': %s", chat_name, err)
            return None
        except ValueError:
            _LOGGER.error("Chat lookup API returned invalid JSON for '%s'", chat_name)
            return None

        matches = payload.get("matches")
        if not isinstance(matches, list):
            _LOGGER.error("Chat lookup API returned invalid matches payload for '%s'", chat_name)
            return None

        if len(matches) == 1 and isinstance(matches[0], dict):
            chat_id = matches[0].get("id")
            if isinstance(chat_id, str) and chat_id:
                return chat_id

        if len(matches) == 0:
            _LOGGER.error("No WhatsApp chat found with name '%s'", chat_name)
            return None

        matched_names = [
            str(match.get("name", "")) for match in matches if isinstance(match, dict)
        ]
        _LOGGER.error(
            "Chat name '%s' is ambiguous (%s). Use chat_id instead.",
            chat_name,
            ", ".join(matched_names),
        )
        return None

    def _resolve_chat_id(self, target: str | None) -> str | None:
        if not target:
            return None
        target = target.strip()
        if not target:
            return None
        if self._is_chat_id(target):
            return target
        return self._resolve_chat_id_from_name(target)

    def send_message(self, message="", **kwargs):
        """Send a message to the target."""
        chat_id = None
        try:
            # Use override target, then config chat_id, then config chat_name.
            target = kwargs.get(ATTR_TARGET)
            if isinstance(target, list):
                target_value = target[0] if target else None
            else:
                target_value = target if target else None

            if target_value:
                chat_id = self._resolve_chat_id(str(target_value))
            elif self.chat_id:
                chat_id = self.chat_id
            elif self.chat_name:
                chat_id = self._resolve_chat_id_from_name(self.chat_name)

            if not chat_id:
                _LOGGER.error(
                    "Unable to resolve chat target. Configure chat_id/chat_name or pass a target."
                )
                return

            data = kwargs.get(ATTR_DATA)

            # Send image if all required image data is present
            if data and all(attr in data for attr in [ATTR_IMAGE, ATTR_IMAGE_TYPE, ATTR_IMAGE_NAME]):
                url = f"http://{self.host_port}/command/media"
                body = {
                    "params": [chat_id, data[ATTR_IMAGE_TYPE], data[ATTR_IMAGE], data[ATTR_IMAGE_NAME]]
                }
                requests.post(url, json=body, timeout=15)
                return

            # Send text message
            title = kwargs.get(ATTR_TITLE)
            msg = f"{title}\n\n{message}" if title else message
            msg = msg.replace("\\n", "\n")

            url = f"http://{self.host_port}/command"
            body = {"command": "sendMessage", "params": [chat_id, msg]}
            requests.post(url, json=body, timeout=15)

        except Exception as e:
            _LOGGER.error("Sending to %s failed: %s", chat_id, e)

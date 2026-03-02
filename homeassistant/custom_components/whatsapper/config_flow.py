"""Config flow for Whatsapper integration."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from . import CONF_HOST_PORT, CONF_WS_PATH, DEFAULT_WS_PATH, DOMAIN


def _normalize_host_port(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def _normalize_ws_path(value: Any) -> str:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped if stripped.startswith("/") else f"/{stripped}"
    return DEFAULT_WS_PATH


def _build_entry_title(host_port: str) -> str:
    if host_port:
        return f"Whatsapper ({host_port})"
    return "Whatsapper (auto-detect)"


class WhatsapperConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Whatsapper."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        return WhatsapperOptionsFlow(config_entry)

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            host_port = _normalize_host_port(user_input.get(CONF_HOST_PORT))
            ws_path = _normalize_ws_path(user_input.get(CONF_WS_PATH))
            return self.async_create_entry(
                title=_build_entry_title(host_port),
                data={
                    CONF_HOST_PORT: host_port,
                    CONF_WS_PATH: ws_path,
                },
            )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_HOST_PORT, default=""): str,
                    vol.Optional(CONF_WS_PATH, default=DEFAULT_WS_PATH): str,
                }
            ),
        )

    async def async_step_hassio(self, discovery_info: HassioServiceInfo):
        """Handle Supervisor add-on discovery."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        host_port = ""
        if isinstance(discovery_info.config, dict):
            host = discovery_info.config.get("host")
            port = discovery_info.config.get("port")
            if isinstance(host, str) and host.strip():
                if isinstance(port, int) and 1 <= port <= 65535:
                    host_port = f"{host.strip()}:{port}"
                elif isinstance(port, str) and port.strip().isdigit():
                    host_port = f"{host.strip()}:{int(port.strip())}"

        return self.async_create_entry(
            title=_build_entry_title(host_port),
            data={
                CONF_HOST_PORT: host_port,
                CONF_WS_PATH: DEFAULT_WS_PATH,
            },
        )


class WhatsapperOptionsFlow(config_entries.OptionsFlow):
    """Handle options for Whatsapper."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self.config_entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        current_host_port = _normalize_host_port(
            self.config_entry.options.get(CONF_HOST_PORT, self.config_entry.data.get(CONF_HOST_PORT, ""))
        )
        current_ws_path = _normalize_ws_path(
            self.config_entry.options.get(CONF_WS_PATH, self.config_entry.data.get(CONF_WS_PATH, DEFAULT_WS_PATH))
        )

        if user_input is not None:
            host_port = _normalize_host_port(user_input.get(CONF_HOST_PORT))
            ws_path = _normalize_ws_path(user_input.get(CONF_WS_PATH))
            self.hass.config_entries.async_update_entry(
                self.config_entry,
                title=_build_entry_title(host_port),
            )
            return self.async_create_entry(
                title="",
                data={
                    CONF_HOST_PORT: host_port,
                    CONF_WS_PATH: ws_path,
                },
            )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_HOST_PORT, default=current_host_port): str,
                    vol.Optional(CONF_WS_PATH, default=current_ws_path): str,
                }
            ),
        )

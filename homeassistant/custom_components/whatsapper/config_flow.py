"""Config flow for Whatsapper integration."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback

try:
    from homeassistant.helpers.service_info.hassio import HassioServiceInfo
except ImportError:  # pragma: no cover - compatibility fallback for older HA cores
    HassioServiceInfo = dict[str, Any]  # type: ignore[assignment,misc]

from . import (
    CONF_HOST_PORT,
    CONF_WS_PATH,
    DEFAULT_WS_PATH,
    DOMAIN,
    CONF_HEARTBEAT_ENABLED,
    CONF_HEARTBEAT_CHAT_NAME,
    CONF_HEARTBEAT_INTERVAL,
    CONF_HEARTBEAT_NOTIFY_TARGETS,
    DEFAULT_HEARTBEAT_INTERVAL,
)


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
    _hassio_discovery_config: dict[str, Any] | None = None
    _hassio_addon_name: str = "Whatsapper add-on"

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        return WhatsapperOptionsFlow()

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

        await self._async_handle_discovery_without_unique_id()
        self._hassio_discovery_config = (
            dict(discovery_info.config) if isinstance(discovery_info.config, dict) else {}
        )
        if isinstance(discovery_info.name, str) and discovery_info.name.strip():
            self._hassio_addon_name = discovery_info.name.strip()
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input: dict[str, Any] | None = None):
        """Confirm Supervisor discovery and allow host/port override."""
        discovered_host_port = ""
        if isinstance(self._hassio_discovery_config, dict):
            host = self._hassio_discovery_config.get("host")
            port = self._hassio_discovery_config.get("port")
            if isinstance(host, str) and host.strip():
                if isinstance(port, int) and 1 <= port <= 65535:
                    discovered_host_port = f"{host.strip()}:{port}"
                elif isinstance(port, str) and port.strip().isdigit():
                    discovered_host_port = f"{host.strip()}:{int(port.strip())}"

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
            step_id="hassio_confirm",
            description_placeholders={
                "addon": self._hassio_addon_name,
            },
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_HOST_PORT, default=discovered_host_port): str,
                    vol.Optional(CONF_WS_PATH, default=DEFAULT_WS_PATH): str,
                }
            ),
        )


def _normalize_notify_targets(value: Any) -> str:
    """Normalise comma-separated notify targets string."""
    if isinstance(value, str):
        return value.strip()
    return ""


class WhatsapperOptionsFlow(config_entries.OptionsFlow):
    """Handle options for Whatsapper."""

    def _current(self, key: str, default: Any) -> Any:
        return self.config_entry.options.get(key, self.config_entry.data.get(key, default))

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        current_host_port = _normalize_host_port(self._current(CONF_HOST_PORT, ""))
        current_ws_path = _normalize_ws_path(self._current(CONF_WS_PATH, DEFAULT_WS_PATH))
        current_hb_enabled = bool(self._current(CONF_HEARTBEAT_ENABLED, False))
        current_hb_chat = str(self._current(CONF_HEARTBEAT_CHAT_NAME, ""))
        current_hb_interval = int(self._current(CONF_HEARTBEAT_INTERVAL, DEFAULT_HEARTBEAT_INTERVAL))
        current_hb_targets = _normalize_notify_targets(self._current(CONF_HEARTBEAT_NOTIFY_TARGETS, ""))

        errors: dict[str, str] = {}

        if user_input is not None:
            host_port = _normalize_host_port(user_input.get(CONF_HOST_PORT))
            ws_path = _normalize_ws_path(user_input.get(CONF_WS_PATH))
            hb_enabled = bool(user_input.get(CONF_HEARTBEAT_ENABLED, False))
            hb_chat = str(user_input.get(CONF_HEARTBEAT_CHAT_NAME, "")).strip()
            hb_interval = user_input.get(CONF_HEARTBEAT_INTERVAL, DEFAULT_HEARTBEAT_INTERVAL)
            hb_targets = _normalize_notify_targets(user_input.get(CONF_HEARTBEAT_NOTIFY_TARGETS, ""))

            try:
                hb_interval = int(hb_interval)
                if hb_interval < 1:
                    raise ValueError
            except (TypeError, ValueError):
                errors[CONF_HEARTBEAT_INTERVAL] = "invalid_interval"

            if not errors:
                self.hass.config_entries.async_update_entry(
                    self.config_entry,
                    title=_build_entry_title(host_port),
                )
                return self.async_create_entry(
                    title="",
                    data={
                        CONF_HOST_PORT: host_port,
                        CONF_WS_PATH: ws_path,
                        CONF_HEARTBEAT_ENABLED: hb_enabled,
                        CONF_HEARTBEAT_CHAT_NAME: hb_chat,
                        CONF_HEARTBEAT_INTERVAL: hb_interval,
                        CONF_HEARTBEAT_NOTIFY_TARGETS: hb_targets,
                    },
                )

        return self.async_show_form(
            step_id="init",
            errors=errors,
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_HOST_PORT, default=current_host_port): str,
                    vol.Optional(CONF_WS_PATH, default=current_ws_path): str,
                    vol.Optional(CONF_HEARTBEAT_ENABLED, default=current_hb_enabled): bool,
                    vol.Optional(CONF_HEARTBEAT_CHAT_NAME, default=current_hb_chat): str,
                    vol.Optional(
                        CONF_HEARTBEAT_INTERVAL, default=current_hb_interval
                    ): vol.All(vol.Coerce(int), vol.Range(min=1)),
                    vol.Optional(CONF_HEARTBEAT_NOTIFY_TARGETS, default=current_hb_targets): str,
                }
            ),
        )

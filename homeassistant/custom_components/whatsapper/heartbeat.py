"""Heartbeat monitor for the Whatsapper integration.

Periodically checks whether the latest heartbeat message in the configured
WhatsApp chat is recent enough.  Maintains a connectivity state sensor and
sends notifications whenever that state changes.

Connectivity states
-------------------
ok                          - heartbeat message seen within the expected window
addon_unreachable           - HTTP/WS connection to the add-on failed
whatsapp_web_js_disconnected - add-on is reachable but WhatsApp is not ready
heartbeat_missed            - add-on + WhatsApp OK but no fresh heartbeat message
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from aiohttp import ClientError
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.const import EVENT_HOMEASSISTANT_STOP

from .auto_host_port import async_detect_host_port
from .rpc import async_resolve_chat_id_from_name, async_ws_rpc_request

_LOGGER = logging.getLogger(__name__)

HEARTBEAT_PREFIX = "Heartbeat "
RUNTIME_INFO_PATH = "/api/v1/wwebjs/runtime"

# How many extra multiples of the interval are allowed before declaring missed.
# E.g. with factor 1.5, if interval=5 min we expect a message within 7.5 min.
MISSED_FACTOR = 1.5

CONNECTIVITY_OK = "ok"
CONNECTIVITY_ADDON_UNREACHABLE = "addon_unreachable"
CONNECTIVITY_WA_DISCONNECTED = "whatsapp_web_js_disconnected"
CONNECTIVITY_HEARTBEAT_MISSED = "heartbeat_missed"

HEARTBEAT_MONITOR_KEY = "_heartbeat_monitor"


class HeartbeatMonitor:
    """Manages the polling loop and sensor state for heartbeat checking."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        configured_host_port: str | None,
        ws_path: str,
        chat_name: str,
        interval_minutes: int,
        notify_targets: list[str],
    ) -> None:
        self.hass = hass
        self.entry = entry
        self._configured_host_port = configured_host_port
        self._ws_path = ws_path
        self._chat_name = chat_name
        self._interval_minutes = interval_minutes
        self._notify_targets = notify_targets

        self._state: str = CONNECTIVITY_OK
        self._cancel_poll: Any = None
        self._stop_unsub: Any = None

        # Sensor entity reference (registered after HA platform is set up)
        self._sensor: WhatsapperConnectivitySensor | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def state(self) -> str:
        return self._state

    def attach_sensor(self, sensor: "WhatsapperConnectivitySensor") -> None:
        self._sensor = sensor

    @callback
    def start(self) -> None:
        from datetime import timedelta

        interval = timedelta(minutes=self._interval_minutes)
        self._cancel_poll = async_track_time_interval(
            self.hass, self._async_poll, interval
        )

        @callback
        def _on_stop(_event: Any = None) -> None:
            self.stop()

        self._stop_unsub = self.hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_STOP, _on_stop
        )
        _LOGGER.info(
            "Heartbeat monitor started (chat=%s interval=%d min)",
            self._chat_name,
            self._interval_minutes,
        )

    @callback
    def stop(self) -> None:
        if self._cancel_poll:
            self._cancel_poll()
            self._cancel_poll = None
        if self._stop_unsub:
            self._stop_unsub()
            self._stop_unsub = None
        _LOGGER.info("Heartbeat monitor stopped")

    # ------------------------------------------------------------------
    # Poll
    # ------------------------------------------------------------------

    async def _async_poll(self, _now: Any = None) -> None:
        new_state = await self._check_connectivity()
        await self._async_update_state(new_state)

    async def _check_connectivity(self) -> str:
        session = async_get_clientsession(self.hass)
        host_port = await async_detect_host_port(
            self.hass, self._configured_host_port
        )

        # 1. Is the add-on reachable?
        try:
            url = f"http://{host_port}{RUNTIME_INFO_PATH}"
            async with session.get(url, timeout=5) as resp:
                if resp.status != 200:
                    return CONNECTIVITY_ADDON_UNREACHABLE
                runtime = await resp.json(content_type=None)
        except (ClientError, TimeoutError, OSError, asyncio.TimeoutError):
            return CONNECTIVITY_ADDON_UNREACHABLE

        # 2. Is WhatsApp Web.js connected/ready?
        wa_state = runtime.get("connectionState") or runtime.get("state") or ""
        initialized = runtime.get("initialized") or runtime.get("clientInitialized")
        if not initialized and wa_state.lower() not in ("connected", "open", "ready", ""):
            return CONNECTIVITY_WA_DISCONNECTED

        # 3. Check for a fresh heartbeat message in the chat.
        if not self._chat_name:
            return CONNECTIVITY_OK

        latest_ts = await self._fetch_latest_heartbeat_ts(host_port)
        if latest_ts is None:
            return CONNECTIVITY_HEARTBEAT_MISSED

        window_seconds = self._interval_minutes * MISSED_FACTOR * 60
        age_seconds = (datetime.now(timezone.utc) - latest_ts).total_seconds()
        if age_seconds > window_seconds:
            return CONNECTIVITY_HEARTBEAT_MISSED

        return CONNECTIVITY_OK

    async def _fetch_latest_heartbeat_ts(self, host_port: str) -> datetime | None:
        """Return the timestamp of the most recent Heartbeat message, or None."""
        try:
            chat_id = await async_resolve_chat_id_from_name(
                self.hass,
                chat_name=self._chat_name,
                configured_host_port=self._configured_host_port,
                ws_path=self._ws_path,
            )
        except Exception:  # pylint: disable=broad-except
            return None

        return await self._fetch_latest_heartbeat_ts_via_rpc(host_port, chat_id)

    async def _fetch_latest_heartbeat_ts_via_rpc(
        self, host_port: str, chat_id: str
    ) -> datetime | None:
        """Use WS RPC list_messages to find recent heartbeat messages."""
        try:
            payload = await async_ws_rpc_request(
                self.hass,
                action="list_messages",
                params={
                    "chatId": chat_id,
                    "limit": max(20, int(self._interval_minutes) * 4),
                    "fromMe": True,
                    "bodyPrefix": HEARTBEAT_PREFIX,
                },
                configured_host_port=self._configured_host_port or host_port,
                ws_path=self._ws_path,
                timeout_seconds=20,
            )
        except Exception:  # pylint: disable=broad-except
            return None

        messages = payload.get("messages")
        if not isinstance(messages, list):
            return None

        timestamps = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            raw_ts = message.get("timestamp")
            if isinstance(raw_ts, (int, float)) and raw_ts > 0:
                timestamps.append(int(raw_ts))

        if not timestamps:
            return None
        latest_timestamp = max(timestamps)
        return datetime.fromtimestamp(latest_timestamp, tz=timezone.utc)

    # ------------------------------------------------------------------
    # State management + notifications
    # ------------------------------------------------------------------

    async def _async_update_state(self, new_state: str) -> None:
        if new_state == self._state:
            return

        old_state = self._state
        self._state = new_state
        _LOGGER.info(
            "Heartbeat connectivity state changed: %s -> %s", old_state, new_state
        )

        if self._sensor:
            self._sensor.async_write_ha_state()

        await self._async_notify_state_change(old_state, new_state)

    async def _async_notify_state_change(self, old_state: str, new_state: str) -> None:
        message = (
            f"Whatsapper connectivity changed: {old_state} → {new_state}"
        )

        # Persistent notification (always).
        self.hass.async_create_task(
            self.hass.services.async_call(
                "persistent_notification",
                "create",
                {
                    "title": "Whatsapper connectivity",
                    "message": message,
                    "notification_id": "whatsapper_connectivity",
                },
                blocking=False,
            )
        )

        # User-configured notify targets.
        for raw_target in self._notify_targets:
            target = raw_target.strip()
            if not target:
                continue
            # Support "notify.mobile_app_phone" or just "mobile_app_phone"
            if "." in target:
                domain, service = target.split(".", 1)
            else:
                domain, service = "notify", target

            try:
                await self.hass.services.async_call(
                    domain,
                    service,
                    {"message": message, "title": "Whatsapper connectivity"},
                    blocking=True,
                )
            except Exception as err:  # pylint: disable=broad-except
                _LOGGER.warning(
                    "Failed to send connectivity notification via %s.%s: %s",
                    domain,
                    service,
                    err,
                )


class WhatsapperConnectivitySensor(Entity):
    """Sensor entity exposing the current Whatsapper connectivity state."""

    _attr_should_poll = False
    _attr_icon = "mdi:heart-pulse"

    def __init__(self, monitor: HeartbeatMonitor, entry: ConfigEntry) -> None:
        self._monitor = monitor
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_connectivity"
        self._attr_name = "Whatsapper connectivity"

    @property
    def state(self) -> str:
        return self._monitor.state

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "chat_name": self._monitor._chat_name,
            "interval_minutes": self._monitor._interval_minutes,
        }

    @property
    def device_info(self) -> dict[str, Any]:
        return {
            "identifiers": {("whatsapper", self._entry.entry_id)},
            "name": "Whatsapper",
            "manufacturer": "Whatsapper",
        }

    async def async_added_to_hass(self) -> None:
        self._monitor.attach_sensor(self)


_CONF_HEARTBEAT_ENABLED = "heartbeat_enabled"
_CONF_HEARTBEAT_CHAT_NAME = "heartbeat_chat_name"
_CONF_HEARTBEAT_INTERVAL = "heartbeat_interval_minutes"
_CONF_HEARTBEAT_NOTIFY_TARGETS = "heartbeat_notify_targets"
_DEFAULT_HEARTBEAT_INTERVAL = 5


async def async_setup_heartbeat(
    hass: HomeAssistant,
    entry: ConfigEntry,
    configured_host_port: str | None,
    ws_path: str,
) -> HeartbeatMonitor | None:
    """Create and start a HeartbeatMonitor for the given config entry.

    Returns None if heartbeat is not enabled or chat_name is missing.
    """
    options = dict(entry.options or {})
    data = dict(entry.data or {})

    def _get(key: str, default: Any) -> Any:
        return options.get(key, data.get(key, default))

    enabled = bool(_get(_CONF_HEARTBEAT_ENABLED, False))
    chat_name = str(_get(_CONF_HEARTBEAT_CHAT_NAME, "")).strip()
    interval = int(_get(_CONF_HEARTBEAT_INTERVAL, _DEFAULT_HEARTBEAT_INTERVAL))
    raw_targets = str(_get(_CONF_HEARTBEAT_NOTIFY_TARGETS, ""))
    notify_targets = [t.strip() for t in raw_targets.split(",") if t.strip()]

    if not enabled or not chat_name:
        _LOGGER.debug(
            "Heartbeat monitor not started (enabled=%s chat_name=%r)", enabled, chat_name
        )
        return None

    monitor = HeartbeatMonitor(
        hass=hass,
        entry=entry,
        configured_host_port=configured_host_port,
        ws_path=ws_path,
        chat_name=chat_name,
        interval_minutes=max(1, interval),
        notify_targets=notify_targets,
    )

    # Register the sensor entity.
    sensor = WhatsapperConnectivitySensor(monitor, entry)
    platform = _get_sensor_platform(hass)
    if platform is not None:
        await platform.async_add_entities([sensor])
    else:
        # Fall back: add via entity registry helper so the state appears.
        _LOGGER.debug("Sensor platform not found; sensor will appear after restart")

    monitor.start()
    return monitor


def _get_sensor_platform(hass: HomeAssistant) -> Any:
    """Return the sensor entity platform helper if available."""
    try:
        from homeassistant.helpers.entity_platform import async_get_platforms

        platforms = async_get_platforms(hass, "whatsapper")
        for platform in platforms:
            if platform.domain == "sensor":
                return platform
    except Exception:  # pylint: disable=broad-except
        pass
    return None

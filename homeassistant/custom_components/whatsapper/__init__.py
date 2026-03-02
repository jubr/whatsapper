"""Whatsapper integration entrypoint."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import quote

import voluptuous as vol
from aiohttp import WSMsgType
from homeassistant.config_entries import ConfigEntry
import homeassistant.helpers.config_validation as cv
from homeassistant.const import CONF_NAME, EVENT_HOMEASSISTANT_STOP, EVENT_HOMEASSISTANT_STARTED
from homeassistant.helpers.discovery import async_load_platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import issue_registry as ir
from homeassistant.loader import async_get_integration
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
RUNTIME_INFO_PATH = "/api/v1/wwebjs/runtime"
VERSION_RELOAD_DELAY_SECONDS = 10
VERSION_MISMATCH_HANDLED_KEY = "_handled_version_mismatch_pairs"
VERSION_RELOAD_TASK_KEY = "_version_reload_task"
START_LISTENER_CALLBACK_KEY = "_start_listener_callback"
STOP_LISTENER_REGISTERED_KEY = "_stop_listener_registered"
LISTENER_SETTINGS_KEY = "_listener_settings"
NOTIFY_PLATFORM_LOADED_KEY = "_notify_platform_loaded"
DEFAULT_NOTIFY_SERVICE_NAME = DOMAIN

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


def _normalize_host_port(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def _normalize_ws_path(value: Any) -> str:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped if stripped.startswith("/") else f"/{stripped}"
    return DEFAULT_WS_PATH


def _to_ha_message_event(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data", {})
    return {
        "event_id": payload.get("eventId"),
        "event_timestamp": payload.get("timestamp"),
        "message_id": data.get("id"),
        "chat_id": data.get("chatId"),
        "chat_name": data.get("chatName"),
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


async def _fetch_addon_version(hass: HomeAssistant, host_port: str) -> str | None:
    session = async_get_clientsession(hass)
    url = f"http://{host_port}{RUNTIME_INFO_PATH}"
    try:
        async with session.get(url, timeout=5) as response:
            if response.status != 200:
                return None
            payload = await response.json(content_type=None)
    except Exception:  # pylint: disable=broad-except
        return None

    if not isinstance(payload, dict):
        return None

    for key in ("appBuildVersion", "appVersion", "version"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


async def _get_integration_version(hass: HomeAssistant) -> str | None:
    try:
        integration = await async_get_integration(hass, DOMAIN)
    except Exception:  # pylint: disable=broad-except
        return None

    version = getattr(integration, "version", None)
    if isinstance(version, str) and version.strip():
        return version.strip()
    return None


def _select_notify_service_name(hass: HomeAssistant) -> str | None:
    notify_services = hass.services.async_services().get("notify")
    if not notify_services:
        return None

    service_names = set(notify_services.keys())
    for preferred in (DOMAIN, "whatsapper", "whatsappur", "whatsapp"):
        if preferred in service_names:
            return preferred

    for service_name in sorted(service_names):
        if "whatsapp" in service_name:
            return service_name
    return None


async def _send_version_mismatch_notice(
    hass: HomeAssistant,
    addon_version: str,
    integration_version: str,
) -> None:
    service_name = _select_notify_service_name(hass)
    if not service_name:
        _LOGGER.warning(
            "Version mismatch detected (%s add-on: %s, integration: %s), but no notify service "
            "matching WhatsApp was found",
            DOMAIN,
            addon_version,
            integration_version,
        )
        return

    message = (
        f"{DOMAIN} add-on version {addon_version} differs from integration version "
        f"{integration_version}. Reloading integration in {VERSION_RELOAD_DELAY_SECONDS} seconds."
    )
    try:
        await hass.services.async_call(
            "notify",
            service_name,
            {"message": message},
            blocking=True,
        )
    except Exception as err:  # pylint: disable=broad-except
        _LOGGER.warning("Failed to send version mismatch notification via notify.%s: %s", service_name, err)


async def _reload_integration_or_listener(hass: HomeAssistant) -> None:
    entries = hass.config_entries.async_entries(DOMAIN)
    if entries:
        for entry in entries:
            try:
                await hass.config_entries.async_reload(entry.entry_id)
                _LOGGER.info("Reloaded config entry %s for %s", entry.entry_id, DOMAIN)
            except Exception as err:  # pylint: disable=broad-except
                _LOGGER.error("Failed to reload config entry %s for %s: %s", entry.entry_id, DOMAIN, err)
        return

    domain_data = hass.data.setdefault(DOMAIN, {})
    listener_task = domain_data.get("listener_task")
    if listener_task and not listener_task.done():
        listener_task.cancel()
        try:
            await listener_task
        except asyncio.CancelledError:
            pass
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.debug("Listener task ended with error during reload fallback: %s", err)

    start_listener = domain_data.get(START_LISTENER_CALLBACK_KEY)
    if callable(start_listener):
        hass.loop.call_soon(start_listener)
        _LOGGER.info("Reloaded %s YAML listener after version mismatch", DOMAIN)
        return

    _LOGGER.warning("Version mismatch reload requested but no config entry or listener callback is available")


def _schedule_delayed_reload(hass: HomeAssistant, reason: str) -> None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    existing_task = domain_data.get(VERSION_RELOAD_TASK_KEY)
    if existing_task and not existing_task.done():
        _LOGGER.debug("Skipping reload schedule (%s): reload already pending", reason)
        return

    task: asyncio.Task | None = None

    async def _delayed_reload() -> None:
        try:
            await asyncio.sleep(VERSION_RELOAD_DELAY_SECONDS)
            await _reload_integration_or_listener(hass)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.error("Delayed reload failed: %s", err)
        finally:
            if task and domain_data.get(VERSION_RELOAD_TASK_KEY) is task:
                domain_data.pop(VERSION_RELOAD_TASK_KEY, None)

    try:
        task = hass.async_create_background_task(
            _delayed_reload(),
            f"{DOMAIN}_delayed_reload",
        )
    except AttributeError:
        task = hass.async_create_task(_delayed_reload())
    domain_data[VERSION_RELOAD_TASK_KEY] = task


async def _handle_successful_reconnect(hass: HomeAssistant, host_port: str) -> None:
    addon_version = await _fetch_addon_version(hass, host_port)
    integration_version = await _get_integration_version(hass)
    if not addon_version or not integration_version:
        return
    if addon_version == integration_version:
        return

    mismatch_key = f"{integration_version}|{addon_version}"
    domain_data = hass.data.setdefault(DOMAIN, {})
    handled_pairs = domain_data.setdefault(VERSION_MISMATCH_HANDLED_KEY, set())
    if not isinstance(handled_pairs, set):
        handled_pairs = set()
        domain_data[VERSION_MISMATCH_HANDLED_KEY] = handled_pairs
    if mismatch_key in handled_pairs:
        return
    handled_pairs.add(mismatch_key)

    _LOGGER.warning(
        "Reconnect version mismatch detected for %s (integration=%s, add-on=%s)",
        DOMAIN,
        integration_version,
        addon_version,
    )
    await _send_version_mismatch_notice(hass, addon_version, integration_version)
    _schedule_delayed_reload(hass, reason=mismatch_key)


@callback
def _start_listener_task(
    hass: HomeAssistant,
    configured_host_port: str | None,
    ws_path: str,
) -> None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    listener_task = domain_data.get("listener_task")
    desired_settings = (configured_host_port or "", ws_path)
    existing_settings = domain_data.get(LISTENER_SETTINGS_KEY)
    if listener_task and not listener_task.done():
        if existing_settings == desired_settings:
            return
        listener_task.cancel()

    try:
        task = hass.async_create_background_task(
            _listen_for_messages(hass, configured_host_port, ws_path),
            f"{DOMAIN}_listener_task",
        )
    except AttributeError:
        task = hass.async_create_task(_listen_for_messages(hass, configured_host_port, ws_path))
    domain_data["listener_task"] = task
    domain_data[LISTENER_SETTINGS_KEY] = desired_settings


def _ensure_stop_listener_registered(hass: HomeAssistant) -> None:
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(STOP_LISTENER_REGISTERED_KEY):
        return

    @callback
    def _on_stop(_event=None) -> None:
        listener_task = domain_data.get("listener_task")
        if listener_task:
            listener_task.cancel()
        reload_task = domain_data.get(VERSION_RELOAD_TASK_KEY)
        if reload_task:
            reload_task.cancel()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _on_stop)
    domain_data[STOP_LISTENER_REGISTERED_KEY] = True


async def _ensure_auto_notify_platform(
    hass: HomeAssistant,
    ws_path: str,
) -> None:
    """Auto-load notify platform so notify.<domain> exists without YAML."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(NOTIFY_PLATFORM_LOADED_KEY):
        return

    if hass.services.has_service("notify", DEFAULT_NOTIFY_SERVICE_NAME):
        _LOGGER.debug(
            "Skipping notify auto-load because notify.%s already exists",
            DEFAULT_NOTIFY_SERVICE_NAME,
        )
        domain_data[NOTIFY_PLATFORM_LOADED_KEY] = True
        return

    discovery_info: dict[str, Any] = {
        CONF_NAME: DEFAULT_NOTIFY_SERVICE_NAME,
        CONF_WS_PATH: ws_path,
    }

    try:
        await async_load_platform(
            hass,
            "notify",
            DOMAIN,
            discovery_info,
            {},
        )
    except Exception as err:  # pylint: disable=broad-except
        _LOGGER.warning("Failed to auto-load notify platform: %s", err)
        return

    domain_data[NOTIFY_PLATFORM_LOADED_KEY] = True
    _LOGGER.info("Auto-loaded notify.%s", DEFAULT_NOTIFY_SERVICE_NAME)


async def _async_reload_entry_on_update(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def _listen_for_messages(
    hass: HomeAssistant,
    configured_host_port: str | None,
    ws_path: str,
) -> None:
    backoff = 2
    successful_ws_connections = 0
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
                successful_ws_connections += 1
                if successful_ws_connections > 1:
                    await _handle_successful_reconnect(hass, host_port)
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
    configured_host_port = _normalize_host_port(conf.get(CONF_HOST_PORT))
    ws_path = _normalize_ws_path(conf.get(CONF_WS_PATH, DEFAULT_WS_PATH))
    domain_data = hass.data.setdefault(DOMAIN, {})

    @callback
    def _start_listener(_event=None) -> None:
        _start_listener_task(hass, configured_host_port, ws_path)

    if hass.is_running:
        hass.loop.call_soon(_start_listener)
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start_listener)

    domain_data[START_LISTENER_CALLBACK_KEY] = _start_listener
    _ensure_stop_listener_registered(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Whatsapper from a config entry (UI setup)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    options = dict(entry.options or {})
    data = dict(entry.data or {})

    configured_host_port = _normalize_host_port(options.get(CONF_HOST_PORT, data.get(CONF_HOST_PORT)))
    ws_path = _normalize_ws_path(options.get(CONF_WS_PATH, data.get(CONF_WS_PATH, DEFAULT_WS_PATH)))

    @callback
    def _start_listener(_event=None) -> None:
        _start_listener_task(hass, configured_host_port, ws_path)

    if hass.is_running:
        hass.loop.call_soon(_start_listener)
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start_listener)

    domain_data[START_LISTENER_CALLBACK_KEY] = _start_listener
    _ensure_stop_listener_registered(hass)
    await _ensure_auto_notify_platform(hass, ws_path)
    entry.async_on_unload(entry.add_update_listener(_async_reload_entry_on_update))
    return True


async def async_unload_entry(hass: HomeAssistant, _entry: ConfigEntry) -> bool:
    """Unload a Whatsapper config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})

    listener_task = domain_data.get("listener_task")
    if listener_task and not listener_task.done():
        listener_task.cancel()
        try:
            await listener_task
        except asyncio.CancelledError:
            pass
        except Exception as err:  # pylint: disable=broad-except
            _LOGGER.debug("Listener task ended with error during unload: %s", err)

    reload_task = domain_data.get(VERSION_RELOAD_TASK_KEY)
    if reload_task and not reload_task.done():
        reload_task.cancel()

    domain_data.pop("listener_task", None)
    domain_data.pop(LISTENER_SETTINGS_KEY, None)
    domain_data.pop(START_LISTENER_CALLBACK_KEY, None)
    domain_data.pop(NOTIFY_PLATFORM_LOADED_KEY, None)
    return True


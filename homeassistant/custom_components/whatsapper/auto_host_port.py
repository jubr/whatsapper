"""Host/port auto-detection helpers for local add-on connectivity."""
from __future__ import annotations

import logging
from typing import Any

from aiohttp import ClientError
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

DOMAIN = "whatsapper"
AUTO_HOST_PORT_DATA_KEY = "_auto_detected_host_port"
DEFAULT_HOST_PORT = "localhost:4000"
DETECT_TIMEOUT_SECONDS = 3

# Ordered by most likely local add-on access paths first.
CANDIDATE_HOST_PORTS = (
    "localhost:4000",
    "localhost:4001",
    "whatsapper:3000",
    "whatsappur:3001",
    "addon_local_whatsapper:3000",
    "addon_local_whatsappur:3001",
)


def _is_runtime_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    app_name = payload.get("appName")
    if app_name in {"whatsapper", "whatsappur"}:
        return True
    return "installedVersion" in payload and "appPort" in payload


async def _probe_host_port(hass: HomeAssistant, host_port: str) -> bool:
    session = async_get_clientsession(hass)
    url = f"http://{host_port}/api/v1/wwebjs/runtime"
    try:
        async with session.get(url, timeout=DETECT_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return False
            payload = await response.json(content_type=None)
            return _is_runtime_payload(payload)
    except (ClientError, TimeoutError, ValueError):
        return False


async def async_detect_host_port(
    hass: HomeAssistant,
    configured_host_port: str | None = None,
    *,
    refresh: bool = False,
) -> str:
    """Resolve host:port for the local Whatsapper/Whatsappur add-on."""

    if isinstance(configured_host_port, str) and configured_host_port.strip():
        return configured_host_port.strip()

    domain_data = hass.data.setdefault(DOMAIN, {})
    if not refresh:
        cached_host_port = domain_data.get(AUTO_HOST_PORT_DATA_KEY)
        if isinstance(cached_host_port, str) and cached_host_port.strip():
            return cached_host_port

    for candidate in CANDIDATE_HOST_PORTS:
        if await _probe_host_port(hass, candidate):
            domain_data[AUTO_HOST_PORT_DATA_KEY] = candidate
            _LOGGER.info("Auto-detected local WhatsApp add-on host_port as %s", candidate)
            return candidate

    _LOGGER.warning(
        "Could not auto-detect local WhatsApp add-on host_port. Falling back to %s",
        DEFAULT_HOST_PORT,
    )
    domain_data[AUTO_HOST_PORT_DATA_KEY] = DEFAULT_HOST_PORT
    return DEFAULT_HOST_PORT

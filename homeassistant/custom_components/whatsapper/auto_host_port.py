"""Host/port auto-detection helpers for local add-on connectivity."""
from __future__ import annotations

import logging
import os
import re
from typing import Any

from aiohttp import ClientError
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

DOMAIN = "whatsapper"
AUTO_HOST_PORT_DATA_KEY = "_auto_detected_host_port"
DEFAULT_HOST_PORT = "localhost:3001"
DETECT_TIMEOUT_SECONDS = 3
SUPERVISOR_TIMEOUT_SECONDS = 4
SUPERVISOR_BASE_URL = "http://supervisor"
SUPERVISOR_TOKEN_ENV = "SUPERVISOR_TOKEN"
TARGET_ADDON_NAMES = ("whatsappur", "whatsapper")

# Ordered fallback candidates after supervisor runtime config detection.
CANDIDATE_HOST_PORTS = (
    "localhost:3001",
    "localhost:3000",
    "localhost:4001",
    "localhost:4000",
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


def _unique(values: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value and value not in seen:
            deduped.append(value)
            seen.add(value)
    return deduped


def _extract_supervisor_data(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    return payload


def _parse_port_number(value: Any) -> int | None:
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str):
        match = re.match(r"^([0-9]{2,5})", value)
        if match:
            parsed = int(match.group(1))
            if 1 <= parsed <= 65535:
                return parsed
    return None


def _extract_ports_from_mapping(mapping: Any) -> list[int]:
    ports: list[int] = []
    if isinstance(mapping, dict):
        for key, value in mapping.items():
            key_port = _parse_port_number(key)
            if key_port:
                ports.append(key_port)
            if isinstance(value, list):
                for item in value:
                    item_port = _parse_port_number(item)
                    if item_port:
                        ports.append(item_port)
            else:
                value_port = _parse_port_number(value)
                if value_port:
                    ports.append(value_port)
    elif isinstance(mapping, list):
        for item in mapping:
            item_port = _parse_port_number(item)
            if item_port:
                ports.append(item_port)
    return ports


def _build_addon_runtime_candidates(slug: str, info_data: dict[str, Any]) -> list[str]:
    ports: list[int] = []
    for direct_port_key in ("ingress_port", "port"):
        port_number = _parse_port_number(info_data.get(direct_port_key))
        if port_number:
            ports.append(port_number)

    for complex_port_key in ("ports", "network", "ingress"):
        ports.extend(_extract_ports_from_mapping(info_data.get(complex_port_key)))

    if not ports:
        return []

    ports = list(dict.fromkeys(ports))
    host_aliases = [f"addon_local_{slug}", slug]
    for host_key in ("hostname", "host"):
        host_value = info_data.get(host_key)
        if isinstance(host_value, str) and host_value.strip():
            host_aliases.append(host_value.strip())

    candidates: list[str] = []
    for host in _unique(host_aliases):
        for port in ports:
            candidates.append(f"{host}:{port}")
    return _unique(candidates)


def _build_slug_fallback_candidates(slugs: list[str]) -> list[str]:
    candidates: list[str] = []
    for slug in slugs:
        host_aliases = _unique([f"addon_local_{slug}", slug])
        for host in host_aliases:
            for port in (3001, 3000):
                candidates.append(f"{host}:{port}")
    return _unique(candidates)


def _matches_target_addon(slug: str) -> bool:
    normalized = slug.lower()
    for target in TARGET_ADDON_NAMES:
        if (
            normalized == target
            or normalized.endswith(f"_{target}")
            or normalized.endswith(f"-{target}")
        ):
            return True
    return False


async def _supervisor_get_json(hass: HomeAssistant, endpoint: str) -> dict[str, Any] | None:
    token = os.environ.get(SUPERVISOR_TOKEN_ENV, "").strip()
    if not token:
        return None

    session = async_get_clientsession(hass)
    url = f"{SUPERVISOR_BASE_URL}{endpoint}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        async with session.get(url, headers=headers, timeout=SUPERVISOR_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return None
            payload = await response.json(content_type=None)
            return payload if isinstance(payload, dict) else None
    except (ClientError, TimeoutError, ValueError):
        return None


async def _detect_from_supervisor_runtime(hass: HomeAssistant) -> list[str]:
    addons_payload = await _supervisor_get_json(hass, "/addons")
    if not addons_payload:
        return []

    addons_data = _extract_supervisor_data(addons_payload)
    addons = addons_data.get("addons")
    if not isinstance(addons, list):
        return []

    matching_slugs = []
    for addon in addons:
        if not isinstance(addon, dict):
            continue
        slug = addon.get("slug")
        if isinstance(slug, str) and _matches_target_addon(slug):
            matching_slugs.append(slug)

    def _slug_priority(slug: str) -> int:
        normalized = slug.lower()
        if normalized.endswith("whatsappur"):
            return 0
        if normalized.endswith("whatsapper"):
            return 1
        return 2

    matching_slugs.sort(key=_slug_priority)

    candidates: list[str] = []
    for slug in matching_slugs:
        info_payload = await _supervisor_get_json(hass, f"/addons/{slug}/info")
        if not info_payload:
            continue
        info_data = _extract_supervisor_data(info_payload)
        candidates.extend(_build_addon_runtime_candidates(slug, info_data))

    candidates.extend(_build_slug_fallback_candidates(matching_slugs))
    return _unique(candidates)


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

    supervisor_candidates = await _detect_from_supervisor_runtime(hass)
    all_candidates = _unique([*supervisor_candidates, *CANDIDATE_HOST_PORTS])
    for candidate in all_candidates:
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

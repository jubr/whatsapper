"""WebSocket RPC helpers shared across the Whatsapper integration."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from uuid import uuid4
from urllib.parse import quote

from aiohttp import WSMsgType
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .auto_host_port import async_detect_host_port

DEFAULT_WS_PATH = "/api/v1/events/ws"


def _normalize_ws_path(value: Any) -> str:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped if stripped.startswith("/") else f"/{stripped}"
    return DEFAULT_WS_PATH


def _build_ws_url(host_port: str, ws_path: str) -> str:
    normalized_path = _normalize_ws_path(ws_path)
    events_query = quote("message", safe=",")
    return f"ws://{host_port}{normalized_path}?events={events_query}"


def _is_chat_id(value: str | None) -> bool:
    return isinstance(value, str) and "@" in value


async def async_ws_rpc_request(
    hass: HomeAssistant,
    *,
    action: str,
    params: dict[str, Any] | None = None,
    configured_host_port: str | None,
    ws_path: str = DEFAULT_WS_PATH,
    timeout_seconds: float = 20,
) -> dict[str, Any]:
    """Call an add-on websocket RPC action and return its result payload."""
    request_id = str(uuid4())
    session = async_get_clientsession(hass)
    attempted_hosts: list[str] = []
    errors: list[str] = []

    first_host = await async_detect_host_port(hass, configured_host_port, refresh=False)
    attempted_hosts.append(first_host)
    if not configured_host_port:
        refreshed_host = await async_detect_host_port(hass, configured_host_port, refresh=True)
        if refreshed_host not in attempted_hosts:
            attempted_hosts.append(refreshed_host)

    for host_port in attempted_hosts:
        ws_url = _build_ws_url(host_port, ws_path)
        try:
            async with session.ws_connect(ws_url, heartbeat=30) as websocket:
                await websocket.send_json(
                    {
                        "type": "rpc",
                        "requestId": request_id,
                        "action": action,
                        "params": params if isinstance(params, dict) else {},
                    }
                )

                while True:
                    ws_message = await asyncio.wait_for(websocket.receive(), timeout=timeout_seconds)
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

                    payload_type = payload.get("type")
                    if payload_type in ("connected", "pong", "integration_version_request"):
                        continue

                    if (
                        payload_type == "rpc_result"
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


async def async_resolve_chat_id_from_name(
    hass: HomeAssistant,
    *,
    chat_name: str,
    configured_host_port: str | None,
    ws_path: str = DEFAULT_WS_PATH,
) -> str:
    """Resolve a chat/channel name to a single chat_id or raise ValueError."""
    normalized_name = str(chat_name).strip()
    if not normalized_name:
        raise ValueError("Chat name is required")

    payload = await async_ws_rpc_request(
        hass,
        action="resolve_chat",
        params={"name": normalized_name},
        configured_host_port=configured_host_port,
        ws_path=ws_path,
    )
    matches = payload.get("matches")
    if not isinstance(matches, list):
        raise ValueError(f"Chat lookup websocket response was invalid for '{normalized_name}'")

    if len(matches) == 1 and isinstance(matches[0], dict):
        chat_id = matches[0].get("id")
        if isinstance(chat_id, str) and chat_id.strip():
            return chat_id.strip()

    if len(matches) == 0:
        raise ValueError(f"No WhatsApp chat found with name '{normalized_name}'")

    matched_names = [str(match.get("name", "")) for match in matches if isinstance(match, dict)]
    raise ValueError(
        f"Chat name '{normalized_name}' is ambiguous ({', '.join(matched_names)}). "
        "Use chat_id instead."
    )


async def async_resolve_chat_id(
    hass: HomeAssistant,
    *,
    target: str,
    configured_host_port: str | None,
    ws_path: str = DEFAULT_WS_PATH,
) -> str:
    """Resolve chat id from either direct id or name."""
    normalized_target = str(target).strip()
    if not normalized_target:
        raise ValueError("Target is required")
    if _is_chat_id(normalized_target):
        return normalized_target
    return await async_resolve_chat_id_from_name(
        hass,
        chat_name=normalized_target,
        configured_host_port=configured_host_port,
        ws_path=ws_path,
    )

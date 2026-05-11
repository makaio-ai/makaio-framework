"""HMAC-SHA256 authentication and server health probing."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import urllib.parse
import urllib.request
from collections.abc import Awaitable, Callable
from typing import Any

from makaio.types import ServerHealth

HEALTH_PROBE_TIMEOUT_S = 3.0


def normalize_bus_secret(raw: str | None) -> str | None:
    """Trim and validate a bus secret.

    @param raw: The raw secret string from the environment, or ``None`` to
        indicate that authentication is disabled.
    @returns: The trimmed secret, or ``None`` if ``raw`` is ``None``.
    @raises ValueError: If ``raw`` is set but evaluates to empty after trimming.
    """
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        raise ValueError("MAKAIO_BUS_SECRET is set but empty after trimming")
    return trimmed


def hmac_sign(secret: str, nonce: str) -> str:
    """Compute HMAC-SHA256(secret, nonce) and return the hex digest.

    @param secret: The shared HMAC secret.
    @param nonce: The server-issued challenge nonce.
    @returns: Lowercase hexadecimal HMAC-SHA256 digest.
    """
    return hmac.new(secret.encode(), nonce.encode(), hashlib.sha256).hexdigest()


async def probe_health(bus_url: str) -> ServerHealth | None:
    """Probe the ``/health`` endpoint to check server availability and auth requirements.

    The URL scheme is mapped as follows: ``wss://`` → ``https://``,
    ``ws://`` → ``http://``. Only the netloc portion is used; the path is
    replaced with ``/health``.

    @param bus_url: The WebSocket bus URL (e.g. ``ws://localhost:4000``).
    @returns: A :class:`~makaio.types.ServerHealth` instance if the server
        responded, or ``None`` if the server was unreachable.
    """
    parsed = urllib.parse.urlparse(bus_url)
    scheme = "https" if parsed.scheme == "wss" else "http"
    health_url = f"{scheme}://{parsed.netloc}/health"

    def _fetch() -> ServerHealth | None:
        try:
            req = urllib.request.Request(health_url)
            with urllib.request.urlopen(req, timeout=HEALTH_PROBE_TIMEOUT_S) as resp:
                body = resp.read().decode()
                if body.strip() == "ok":
                    return ServerHealth(auth=False)
                data = json.loads(body)
                if isinstance(data, dict) and data.get("ok"):
                    return ServerHealth(auth=bool(data.get("auth", False)))
                return None
        except Exception:
            return None

    return await asyncio.to_thread(_fetch)


async def run_auth_handshake(
    send: Callable[[dict[str, Any]], Awaitable[None]],
    recv_message: Callable[[], Awaitable[dict[str, Any]]],
    secret: str,
    *,
    timeout_s: float = 5.0,
) -> None:
    """Run HMAC challenge-response authentication over a transport.

    The expected message exchange is:

    1. Server → Client: ``{"type": "auth-challenge", "nonce": "<nonce>"}``
    2. Client → Server: ``{"type": "auth-response", "signature": "<hex>"}``
    3. Server → Client: ``{"type": "auth-result", "success": true}``

    @param send: Async callable that sends a :class:`dict` as a wire message.
    @param recv_message: Async callable that returns the next wire message dict.
    @param secret: Shared HMAC secret used to sign the server-issued nonce.
    @param timeout_s: Maximum time in seconds to complete the handshake.
    @raises RuntimeError: If the server rejects authentication or the message
        sequence is unexpected.
    @raises asyncio.TimeoutError: If the handshake does not complete within
        ``timeout_s`` seconds.
    """

    async def _handshake() -> None:
        challenge = await recv_message()
        if challenge.get("type") != "auth-challenge":
            raise RuntimeError(
                f"Expected auth-challenge, got {challenge.get('type')!r}"
            )
        nonce = challenge.get("nonce")
        if not isinstance(nonce, str):
            raise RuntimeError("auth-challenge missing nonce")
        signature = hmac_sign(secret, nonce)
        await send({"type": "auth-response", "signature": signature})
        result = await recv_message()
        if result.get("type") != "auth-result":
            raise RuntimeError(
                f"Expected auth-result, got {result.get('type')!r}"
            )
        if not result.get("success"):
            raise RuntimeError("HMAC authentication failed")

    await asyncio.wait_for(_handshake(), timeout=timeout_s)

"""Tests for HMAC-SHA256 authentication and health probe module."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from makaio._auth import hmac_sign, normalize_bus_secret, probe_health, run_auth_handshake
from makaio.types import ServerHealth

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeTransport:
    """Minimal async transport for testing auth handshake."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self._recv_queue: asyncio.Queue[dict] = asyncio.Queue()

    async def send(self, msg: dict) -> None:
        """Record the outgoing message."""
        self.sent.append(msg)

    async def recv(self) -> dict:
        """Return the next queued inbound message."""
        return await self._recv_queue.get()

    def push(self, msg: dict) -> None:
        """Enqueue an inbound message for the next recv() call."""
        self._recv_queue.put_nowait(msg)


def _make_urlopen_mock(body: str | bytes) -> MagicMock:
    """Build a context-manager mock that simulates urlopen returning ``body``."""
    if isinstance(body, str):
        body = body.encode()
    response = MagicMock()
    response.read.return_value = body
    response.__enter__ = MagicMock(return_value=response)
    response.__exit__ = MagicMock(return_value=False)
    return response


# ---------------------------------------------------------------------------
# HMAC signing tests
# ---------------------------------------------------------------------------


class HmacSignTest(unittest.TestCase):
    def test_hmac_sign(self) -> None:
        """hmac_sign produces a hex-encoded SHA-256 HMAC digest."""
        secret = "my-secret"
        nonce = "some-nonce"
        expected = hmac.new(secret.encode(), nonce.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(hmac_sign(secret, nonce), expected)

    def test_hmac_sign_matches_typescript(self) -> None:
        """Cross-language: known secret+nonce pair produces the expected hex."""
        # Computed independently: hmac.new(b'test-secret', b'test-nonce-12345', sha256).hexdigest()
        expected = "c0d4434a0b8df427d027aa436095716b35502a8b7c53eb3fa24256ccc4d5776f"
        self.assertEqual(hmac_sign("test-secret", "test-nonce-12345"), expected)


# ---------------------------------------------------------------------------
# normalize_bus_secret tests
# ---------------------------------------------------------------------------


class NormalizeBusSecretTest(unittest.TestCase):
    def test_normalize_secret_empty_raises(self) -> None:
        """Empty and whitespace-only secrets raise ValueError."""
        with self.assertRaises(ValueError):
            normalize_bus_secret("")
        with self.assertRaises(ValueError):
            normalize_bus_secret("   ")
        with self.assertRaises(ValueError):
            normalize_bus_secret("\t\n")

    def test_normalize_secret_trim(self) -> None:
        """Leading and trailing whitespace is stripped from the secret."""
        self.assertEqual(normalize_bus_secret("  my-secret  "), "my-secret")
        self.assertEqual(normalize_bus_secret("\ttoken\n"), "token")

    def test_normalize_secret_none_passthrough(self) -> None:
        """None is returned unchanged (auth disabled)."""
        self.assertIsNone(normalize_bus_secret(None))

    def test_normalize_secret_clean_value_unchanged(self) -> None:
        """A value with no surrounding whitespace is returned as-is."""
        self.assertEqual(normalize_bus_secret("clean-secret"), "clean-secret")


# ---------------------------------------------------------------------------
# probe_health tests
# ---------------------------------------------------------------------------


class ProbeHealthTest(unittest.IsolatedAsyncioTestCase):
    async def test_probe_health_auth_required(self) -> None:
        """JSON body {"ok": true, "auth": true} → ServerHealth(auth=True)."""
        mock_response = _make_urlopen_mock(json.dumps({"ok": True, "auth": True}))
        with patch("urllib.request.urlopen", return_value=mock_response):
            result = await probe_health("ws://localhost:4000")
        self.assertEqual(result, ServerHealth(auth=True))

    async def test_probe_health_no_auth(self) -> None:
        """Plain "ok" body → ServerHealth(auth=False)."""
        mock_response = _make_urlopen_mock("ok")
        with patch("urllib.request.urlopen", return_value=mock_response):
            result = await probe_health("ws://localhost:4000")
        self.assertEqual(result, ServerHealth(auth=False))

    async def test_probe_health_unreachable(self) -> None:
        """Connection error → returns None."""
        with patch("urllib.request.urlopen", side_effect=OSError("Connection refused")):
            result = await probe_health("ws://localhost:4000")
        self.assertIsNone(result)

    async def test_probe_health_wss_uses_https(self) -> None:
        """wss:// scheme is mapped to https:// for the health endpoint."""
        captured_urls: list[str] = []

        def fake_urlopen(req, timeout=None):
            captured_urls.append(req.full_url)
            return _make_urlopen_mock("ok")

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            await probe_health("wss://example.com:4000")

        self.assertEqual(len(captured_urls), 1)
        self.assertTrue(captured_urls[0].startswith("https://"))


# ---------------------------------------------------------------------------
# run_auth_handshake tests
# ---------------------------------------------------------------------------


class RunAuthHandshakeTest(unittest.IsolatedAsyncioTestCase):
    async def test_auth_handshake(self) -> None:
        """Successful challenge-response: client signs the nonce and confirms success."""
        transport = FakeTransport()
        nonce = "handshake-nonce-abc"
        secret = "shared-secret"

        transport.push({"type": "auth-challenge", "nonce": nonce})
        transport.push({"type": "auth-result", "success": True})

        await run_auth_handshake(transport.send, transport.recv, secret)

        self.assertEqual(len(transport.sent), 1)
        response = transport.sent[0]
        self.assertEqual(response["type"], "auth-response")
        self.assertEqual(response["signature"], hmac_sign(secret, nonce))

    async def test_auth_handshake_failure(self) -> None:
        """Server returning success=False raises RuntimeError."""
        transport = FakeTransport()
        transport.push({"type": "auth-challenge", "nonce": "some-nonce"})
        transport.push({"type": "auth-result", "success": False})

        with self.assertRaises(RuntimeError):
            await run_auth_handshake(transport.send, transport.recv, "secret")

    async def test_auth_handshake_wrong_first_message_type_raises(self) -> None:
        """First message that is not auth-challenge raises RuntimeError."""
        transport = FakeTransport()
        transport.push({"type": "event", "payload": {}})

        with self.assertRaises(RuntimeError):
            await run_auth_handshake(transport.send, transport.recv, "secret")

    async def test_auth_handshake_missing_nonce_raises(self) -> None:
        """auth-challenge without a nonce field raises RuntimeError."""
        transport = FakeTransport()
        transport.push({"type": "auth-challenge"})

        with self.assertRaises(RuntimeError):
            await run_auth_handshake(transport.send, transport.recv, "secret")

    async def test_auth_handshake_timeout(self) -> None:
        """Handshake that never completes raises asyncio.TimeoutError."""
        transport = FakeTransport()
        # Do not push any messages — recv will block forever.

        with self.assertRaises(asyncio.TimeoutError):
            await run_auth_handshake(transport.send, transport.recv, "secret", timeout_s=0.05)


if __name__ == "__main__":
    unittest.main()

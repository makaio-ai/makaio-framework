"""Tests for the WebSocket transport abstraction."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from makaio._transport import StdioTransport, WebSocketTransport


class FakeWebSocket:
    """Minimal in-process websocket double for transport tests."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._recv_queue: asyncio.Queue[str | bytes | Exception] = asyncio.Queue()
        self.closed = False

    async def send(self, message: str) -> None:
        """Record the outgoing frame."""
        self.sent.append(message)

    async def recv(self) -> str | bytes:
        """Return the next queued frame."""
        item = await self._recv_queue.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self) -> None:
        """Mark as closed."""
        self.closed = True

    def push(self, data: dict) -> None:
        """Enqueue a dict as a JSON string frame."""
        self._recv_queue.put_nowait(json.dumps(data))

    def push_bytes(self, data: dict) -> None:
        """Enqueue a dict as UTF-8 bytes frame."""
        self._recv_queue.put_nowait(json.dumps(data).encode("utf-8"))


# ---------------------------------------------------------------------------
# connect
# ---------------------------------------------------------------------------


async def test_connect_with_factory() -> None:
    """Factory is called with the URL and the transport is connected."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)

    await transport.connect()

    assert transport._websocket is ws


async def test_connect_with_awaitable_factory() -> None:
    """Async factory (returns an awaitable) is properly awaited."""
    ws = FakeWebSocket()

    async def async_factory(url: str) -> FakeWebSocket:
        return ws

    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=async_factory)
    await transport.connect()

    assert transport._websocket is ws


# ---------------------------------------------------------------------------
# send
# ---------------------------------------------------------------------------


async def test_send_serializes_json() -> None:
    """Message dict is serialized as compact JSON and sent over the websocket."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    await transport.send({"type": "event", "subject": "test"})

    assert len(ws.sent) == 1
    parsed = json.loads(ws.sent[0])
    assert parsed == {"type": "event", "subject": "test"}


async def test_send_uses_compact_separators() -> None:
    """JSON output uses no extra whitespace (compact separators)."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    await transport.send({"a": 1, "b": 2})

    assert " " not in ws.sent[0], "JSON output must not contain spaces"


async def test_send_before_connect_raises() -> None:
    """Sending before connect raises RuntimeError."""
    transport = WebSocketTransport("ws://localhost:3000")

    try:
        await transport.send({"type": "event"})
        assert False, "Expected RuntimeError"
    except RuntimeError:
        pass


# ---------------------------------------------------------------------------
# messages
# ---------------------------------------------------------------------------


async def test_messages_yields_parsed_json() -> None:
    """Pushed string frames are yielded as parsed dicts."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    ws.push({"type": "event", "subject": "greet"})

    # Drain the first message then close so the iterator terminates.
    received: list[dict] = []
    async for msg in transport.messages():
        received.append(msg)
        await transport.close()

    assert received == [{"type": "event", "subject": "greet"}]


async def test_messages_handles_bytes() -> None:
    """Byte frames are decoded from UTF-8 before JSON parsing."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    ws.push_bytes({"type": "heartbeat"})

    received: list[dict] = []
    async for msg in transport.messages():
        received.append(msg)
        await transport.close()

    assert received == [{"type": "heartbeat"}]


async def test_messages_propagates_recv_error() -> None:
    """When recv raises an exception the iterator propagates the transport drop."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    # Inject an exception into the recv queue.
    ws._recv_queue.put_nowait(Exception("connection dropped"))  # type: ignore[arg-type]

    try:
        async for _ in transport.messages():
            pass
        assert False, "expected recv error to propagate"
    except Exception as error:
        assert str(error) == "connection dropped"


class MemoryReader:
    """Async line reader for stdio transport tests."""

    def __init__(self) -> None:
        self.lines: asyncio.Queue[bytes] = asyncio.Queue()

    async def readline(self) -> bytes:
        """Return the next queued line."""
        return await self.lines.get()

    def push(self, message: dict) -> None:
        """Queue one JSON line."""
        self.lines.put_nowait(json.dumps(message).encode("utf-8") + b"\n")

    def close(self) -> None:
        """Queue EOF."""
        self.lines.put_nowait(b"")


class MemoryWriter:
    """Async writer sink for stdio transport tests."""

    def __init__(self) -> None:
        self.frames: list[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        """Record one outbound chunk."""
        self.frames.append(data)

    async def drain(self) -> None:
        """Flush no-op for memory writer."""
        pass

    def close(self) -> None:
        """Mark closed."""
        self.closed = True


async def test_stdio_transport_sends_newline_delimited_json() -> None:
    """Stdio transport writes compact JSON lines."""
    reader = MemoryReader()
    writer = MemoryWriter()
    transport = StdioTransport(reader, writer)
    await transport.connect()

    await transport.send({"type": "event", "subject": "test"})

    assert writer.frames == [b'{"type":"event","subject":"test"}\n']


async def test_stdio_transport_yields_json_lines() -> None:
    """Stdio transport parses inbound JSON lines."""
    reader = MemoryReader()
    writer = MemoryWriter()
    transport = StdioTransport(reader, writer)
    await transport.connect()
    reader.push({"type": "subscribe-sync-complete"})

    received: list[dict] = []
    async for message in transport.messages():
        received.append(message)
        reader.close()

    assert received == [{"type": "subscribe-sync-complete"}]


# ---------------------------------------------------------------------------
# close
# ---------------------------------------------------------------------------


async def test_close_clears_websocket() -> None:
    """After close the internal websocket reference is None."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    await transport.close()

    assert transport._websocket is None


async def test_close_delegates_to_websocket() -> None:
    """close() calls close() on the underlying websocket."""
    ws = FakeWebSocket()
    transport = WebSocketTransport("ws://localhost:3000", websocket_factory=lambda url: ws)
    await transport.connect()

    await transport.close()

    assert ws.closed is True


async def test_close_when_not_connected_is_noop() -> None:
    """Calling close on a transport that was never connected does not raise."""
    transport = WebSocketTransport("ws://localhost:3000")

    # Must not raise.
    await transport.close()

    assert transport._websocket is None

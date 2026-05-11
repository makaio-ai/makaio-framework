"""Pluggable transport abstraction for the Makaio bus protocol."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import sys
from collections.abc import AsyncIterator, Mapping
from typing import Any, Protocol

from makaio.types import WebSocketFactory, WebSocketLike

LOGGER = logging.getLogger(__name__)


class Transport(Protocol):
    """Pluggable transport for the bus wire protocol.

    Concrete implementations must provide connect/send/close lifecycle
    methods and an async-generator message stream.
    """

    async def connect(self) -> None:
        """Open the transport connection."""
        ...

    async def send(self, message: Mapping[str, Any]) -> None:
        """Serialise and transmit a message.

        @param message: The message dict to send over the wire.
        """
        ...

    async def close(self) -> None:
        """Tear down the transport connection."""
        ...

    def messages(self) -> AsyncIterator[dict[str, Any]]:
        """Yield decoded inbound messages until the connection is closed.

        @returns: An async iterator of parsed message dicts.
        """
        ...


class WebSocketTransport:
    """WebSocket-based bus transport.

    Wraps a ``WebSocketLike`` connection and exposes the ``Transport``
    protocol surface.  A custom ``websocket_factory`` can be injected
    for testing or alternative WebSocket libraries.

    @param url: The WebSocket server URL to connect to.
    @param websocket_factory: Optional factory callable that accepts a URL
        string and returns a ``WebSocketLike`` instance (or an awaitable
        that resolves to one).  When omitted the ``websockets`` package
        is used directly.
    """

    def __init__(
        self,
        url: str,
        *,
        websocket_factory: WebSocketFactory | None = None,
    ) -> None:
        self.url = url
        self._websocket_factory = websocket_factory
        self._websocket: WebSocketLike | None = None

    async def connect(self) -> None:
        """Open the WebSocket connection.

        Uses the injected ``websocket_factory`` when present, otherwise
        falls back to the ``websockets`` library.
        """
        if self._websocket_factory is not None:
            ws = self._websocket_factory(self.url)
            if inspect.isawaitable(ws):
                ws = await ws
            self._websocket = ws
        else:
            try:
                from websockets.asyncio.client import connect
            except ImportError:
                from websockets import connect  # type: ignore[no-redef]
            self._websocket = await connect(self.url)

    async def send(self, message: Mapping[str, Any]) -> None:
        """Serialise ``message`` as compact JSON and send it over the socket.

        @param message: The message dict to transmit.
        @raises RuntimeError: If the transport is not yet connected.
        """
        if self._websocket is None:
            raise RuntimeError("Transport is not connected")
        await self._websocket.send(json.dumps(message, separators=(",", ":")))

    async def close(self) -> None:
        """Close the underlying WebSocket connection.

        Clears the internal reference before closing so that any
        concurrent ``messages()`` loop terminates cleanly.
        """
        ws = self._websocket
        self._websocket = None
        if ws is not None:
            await ws.close()

    async def messages(self) -> AsyncIterator[dict[str, Any]]:
        """Yield inbound messages as parsed dicts until the connection drops.

        Binary frames are UTF-8 decoded before JSON parsing.  Receive errors
        propagate so the owning bus client can close the connection and fail
        pending requests.

        @returns: An async iterator of parsed message dicts.
        """
        while self._websocket is not None:
            try:
                raw = await self._websocket.recv()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.debug("WebSocket recv failed", exc_info=True)
                raise
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            yield json.loads(raw)


class StdioTransport:
    """Line-delimited JSON transport over stdin/stdout-style streams.

    @param input_stream: Optional async stream exposing ``readline()``. When
        omitted, process stdin is attached through ``asyncio`` pipes.
    @param output_stream: Optional stream exposing ``write()`` and optionally
        ``drain()`` / ``close()``. When omitted, process stdout is attached
        through ``asyncio`` pipes.
    """

    def __init__(
        self,
        input_stream: Any | None = None,
        output_stream: Any | None = None,
    ) -> None:
        self._input_stream = input_stream
        self._output_stream = output_stream
        self._reader: Any | None = None
        self._writer: Any | None = None

    async def connect(self) -> None:
        """Attach the configured input/output streams."""
        if self._input_stream is not None or self._output_stream is not None:
            self._reader = self._input_stream
            self._writer = self._output_stream
            return

        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        reader_protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin.buffer)

        writer_transport, writer_protocol = await loop.connect_write_pipe(
            # StreamWriter.drain() requires FlowControlMixin-compatible protocol
            # hooks, and asyncio exposes no public stdout-pipe factory with those
            # hooks. Tests inject streams directly; this path is the real stdio
            # transport bridge where preserving drain/backpressure matters.
            asyncio.streams.FlowControlMixin,
            sys.stdout.buffer,
        )
        self._reader = reader
        self._writer = asyncio.StreamWriter(
            writer_transport,
            writer_protocol,
            None,
            loop,
        )

    async def send(self, message: Mapping[str, Any]) -> None:
        """Serialize ``message`` as compact JSON followed by a newline.

        @param message: The message dict to transmit.
        @raises RuntimeError: If the transport is not connected.
        """
        writer = self._writer
        if writer is None:
            raise RuntimeError("Transport is not connected")

        frame = json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n"
        writer.write(frame)
        drain = getattr(writer, "drain", None)
        if drain is not None:
            result = drain()
            if inspect.isawaitable(result):
                await result

    async def close(self) -> None:
        """Close the output stream when it exposes a close hook."""
        writer = self._writer
        self._reader = None
        self._writer = None
        if writer is None:
            return

        close = getattr(writer, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result
        wait_closed = getattr(writer, "wait_closed", None)
        if wait_closed is not None:
            result = wait_closed()
            if inspect.isawaitable(result):
                await result

    async def messages(self) -> AsyncIterator[dict[str, Any]]:
        """Yield newline-delimited JSON messages until EOF.

        @returns: An async iterator of parsed message dicts.
        @raises RuntimeError: If the transport is not connected.
        """
        reader = self._reader
        if reader is None:
            raise RuntimeError("Transport is not connected")

        while self._reader is reader:
            raw = reader.readline()
            if inspect.isawaitable(raw):
                raw = await raw
            if raw == b"" or raw == "":
                return
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            yield json.loads(raw)

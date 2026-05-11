"""Shared test fakes for the Makaio SDK test suite."""

from __future__ import annotations

import asyncio
import json
from typing import Any


class FakeWebSocket:
    """Minimal fake WebSocket implementing the WebSocketLike protocol.

    Outbound frames are recorded in ``sent`` as decoded dicts.  Inbound frames
    are pushed via :meth:`push` (sync) or :meth:`receive` (async).
    """

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._recv_queue: asyncio.Queue[str | Exception] = asyncio.Queue()
        self.closed = False

    async def send(self, message: str) -> None:
        """Record an outbound frame as a decoded dict.

        @param message: Compact-JSON serialised wire frame.
        """
        self.sent.append(json.loads(message))

    async def recv(self) -> str:
        """Return the next server→client frame, or raise if an exception was queued.

        @returns: Raw JSON string to be parsed by the transport.
        @raises Exception: If an exception was pushed instead of a frame.
        """
        item = await self._recv_queue.get()
        if isinstance(item, Exception):
            raise item
        return item  # type: ignore[return-value]

    async def close(self) -> None:
        """Mark the socket as closed and unblock any pending recv."""
        self.closed = True
        self._recv_queue.put_nowait('{"type":"__close__"}')

    def push(self, data: dict[str, Any]) -> None:
        """Enqueue a message dict as JSON for the next recv() call.

        @param data: Message dict to deliver to the client on the next recv.
        """
        self._recv_queue.put_nowait(json.dumps(data))

    async def receive(self, message: dict[str, Any]) -> None:
        """Inject a JSON-serialisable message as an inbound frame.

        Async alias for :meth:`push` for callers that prefer await syntax.

        @param message: Message dict to deliver as an inbound frame.
        """
        self._recv_queue.put_nowait(json.dumps(message))

    async def wait_sent(
        self,
        count: int,
        *,
        timeout: float = 2.0,
        interval: float = 0.01,
    ) -> dict[str, Any]:
        """Wait until at least *count* frames have been sent and return the last.

        @param count: Minimum number of sent frames to wait for.
        @param timeout: Maximum seconds to wait.
        @param interval: Polling interval in seconds.
        @returns: The frame at index ``count - 1`` in :attr:`sent`.
        @raises AssertionError: If ``timeout`` elapses before ``count`` frames arrive.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if len(self.sent) >= count:
                return self.sent[count - 1]
            await asyncio.sleep(interval)
        if len(self.sent) >= count:
            return self.sent[count - 1]
        raise AssertionError(
            f'expected {count} sent frames, got {len(self.sent)}: {self.sent}'
        )

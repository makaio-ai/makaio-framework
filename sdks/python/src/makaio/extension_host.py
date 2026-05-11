"""Lifecycle wrapper for detached extension processes."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Union

from makaio.bus import BusClient


class ExtensionHost:
    """Manages init → ready → operate → destroy → stopped for detached extensions.

    A detached extension process creates an :class:`ExtensionHost`, registers
    callbacks, calls :meth:`start` to await the coordinator's ``init`` signal and
    advertise readiness, then calls :meth:`run_until_destroyed` to block until the
    coordinator sends the ``destroy`` signal before cleanly stopping.

    @param name: The extension descriptor name (used to build bus subject strings).
    @param client: A connected :class:`BusClient` instance.
    """

    def __init__(self, name: str, client: BusClient) -> None:
        self.name = name
        self.client = client
        self._on_init: list[Callable[[], Union[Awaitable[None], None]]] = []
        self._on_destroy: list[Callable[[], Union[Awaitable[None], None]]] = []

    def on_init(
        self,
        handler: Callable[[], Union[Awaitable[None], None]],
    ) -> Callable[[], Union[Awaitable[None], None]]:
        """Register a callback invoked when the coordinator sends the init signal.

        Callbacks are invoked in registration order. Both sync and async callables
        are accepted. Callback failures are fail-fast: ``ready`` is emitted only
        after every init callback succeeds.

        @param handler: Sync or async callable invoked during the init phase.
        @returns: The registered handler for decorator usage.
        """
        self._on_init.append(handler)
        return handler

    def on_destroy(
        self,
        handler: Callable[[], Union[Awaitable[None], None]],
    ) -> Callable[[], Union[Awaitable[None], None]]:
        """Register a callback invoked when the coordinator sends the destroy signal.

        Callbacks are invoked in registration order. Both sync and async callables
        are accepted. Callback failures are fail-fast: ``stopped`` is emitted only
        after every destroy callback succeeds.

        @param handler: Sync or async callable invoked during the destroy phase.
        @returns: The registered handler for decorator usage.
        """
        self._on_destroy.append(handler)
        return handler

    async def start(self) -> None:
        """Wait for the coordinator's init signal, run init callbacks, then emit ready.

        Blocks until ``extension.<name>.init`` arrives on the bus. After all
        registered :meth:`on_init` callbacks complete, emits
        ``extension.<name>.ready`` to signal that the extension is operational.
        """
        init_subject = f'extension.{self.name}.init'
        ready_subject = f'extension.{self.name}.ready'

        await self.client.once(init_subject)
        for callback in self._on_init:
            result = callback()
            if inspect.isawaitable(result):
                await result

        await self.client.emit(ready_subject, {'name': self.name})

    async def run_until_destroyed(self) -> None:
        """Block until the coordinator's destroy signal, run destroy callbacks, emit stopped.

        Blocks until ``extension.<name>.destroy`` arrives on the bus. After all
        registered :meth:`on_destroy` callbacks complete, emits
        ``extension.<name>.stopped`` to signal that the extension has shut down.
        """
        destroy_subject = f'extension.{self.name}.destroy'
        stopped_subject = f'extension.{self.name}.stopped'

        await self.client.once(destroy_subject)
        for callback in self._on_destroy:
            result = callback()
            if inspect.isawaitable(result):
                await result

        await self.client.emit(stopped_subject, {'name': self.name})

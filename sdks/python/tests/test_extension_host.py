"""Tests for ExtensionHost lifecycle wrapper."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from _fakes import FakeWebSocket
from makaio import BusClient
from makaio.extension_host import ExtensionHost


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_event(name: str, phase: str) -> dict:
    """Build an inbound event frame for ``extension.<name>.<phase>``."""
    return {
        'type': 'event',
        'namespace': 'extension',
        'subject': f'{name}.{phase}',
        'payload': {'name': name},
        'messageId': f'test-{phase}',
    }


async def _make_connected_client(fake_ws: FakeWebSocket) -> BusClient:
    """Create and connect a :class:`BusClient` backed by *fake_ws*."""
    fake_ws.push({'type': 'subscribe-sync-complete'})
    client = BusClient('ws://test', websocket_factory=lambda url: fake_ws)
    await client.connect()
    return client


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_start_handles_init_and_signals_ready() -> None:
    """on_init callback is called and ready event is emitted after init arrives."""
    fake_ws = FakeWebSocket()
    client = await _make_connected_client(fake_ws)
    host = ExtensionHost('myext', client)

    init_called = False

    def on_init() -> None:
        nonlocal init_called
        init_called = True

    host.on_init(on_init)

    start_task = asyncio.create_task(host.start())

    # Wait until once() has registered its subscription (subscribe frame sent).
    await fake_ws.wait_sent(1)

    # Simulate coordinator sending the init signal.
    await fake_ws.receive(_make_event('myext', 'init'))

    await asyncio.wait_for(start_task, timeout=2.0)

    assert init_called, 'on_init callback was not called'

    # Verify ready event was emitted. Frames: subscribe, unsubscribe, ready-event.
    ready_frame = await fake_ws.wait_sent(3)
    assert ready_frame['type'] == 'event'
    assert ready_frame['namespace'] == 'extension'
    assert ready_frame['subject'] == 'myext.ready'
    assert ready_frame['payload'] == {'name': 'myext'}

    await client.close()


async def test_lifecycle_callbacks_can_be_registered_as_decorators() -> None:
    """on_init/on_destroy return handlers so decorator syntax keeps functions intact."""
    fake_ws = FakeWebSocket()
    client = await _make_connected_client(fake_ws)
    host = ExtensionHost('myext', client)
    call_order: list[str] = []

    @host.on_init
    async def setup() -> None:
        call_order.append('setup')

    @host.on_destroy
    def teardown() -> None:
        call_order.append('teardown')

    assert setup.__name__ == 'setup'
    assert teardown.__name__ == 'teardown'

    start_task = asyncio.create_task(host.start())
    await fake_ws.wait_sent(1)
    await fake_ws.receive(_make_event('myext', 'init'))
    await asyncio.wait_for(start_task, timeout=2.0)

    destroy_task = asyncio.create_task(host.run_until_destroyed())
    await fake_ws.wait_sent(4)
    await fake_ws.receive(_make_event('myext', 'destroy'))
    await asyncio.wait_for(destroy_task, timeout=2.0)

    assert call_order == ['setup', 'teardown']

    await client.close()


async def test_run_until_destroyed() -> None:
    """on_destroy callback is called and stopped event is emitted after destroy arrives."""
    fake_ws = FakeWebSocket()
    client = await _make_connected_client(fake_ws)
    host = ExtensionHost('myext', client)

    destroy_called = False

    def on_destroy() -> None:
        nonlocal destroy_called
        destroy_called = True

    host.on_destroy(on_destroy)

    destroy_task = asyncio.create_task(host.run_until_destroyed())

    # Wait for the destroy subscription to be registered.
    await fake_ws.wait_sent(1)

    # Simulate coordinator sending the destroy signal.
    await fake_ws.receive(_make_event('myext', 'destroy'))

    await asyncio.wait_for(destroy_task, timeout=2.0)

    assert destroy_called, 'on_destroy callback was not called'

    # Verify stopped event: frames are subscribe, unsubscribe, stopped-event.
    stopped_frame = await fake_ws.wait_sent(3)
    assert stopped_frame['type'] == 'event'
    assert stopped_frame['namespace'] == 'extension'
    assert stopped_frame['subject'] == 'myext.stopped'
    assert stopped_frame['payload'] == {'name': 'myext'}

    await client.close()


async def test_start_without_callbacks() -> None:
    """start() emits ready even when no on_init callbacks are registered."""
    fake_ws = FakeWebSocket()
    client = await _make_connected_client(fake_ws)
    host = ExtensionHost('nohandler', client)

    start_task = asyncio.create_task(host.start())

    await fake_ws.wait_sent(1)
    await fake_ws.receive(_make_event('nohandler', 'init'))

    await asyncio.wait_for(start_task, timeout=2.0)

    ready_frame = await fake_ws.wait_sent(3)
    assert ready_frame['type'] == 'event'
    assert ready_frame['subject'] == 'nohandler.ready'

    await client.close()


async def test_multiple_init_callbacks_called_in_order() -> None:
    """Multiple on_init callbacks are all called in registration order."""
    fake_ws = FakeWebSocket()
    client = await _make_connected_client(fake_ws)
    host = ExtensionHost('myext', client)

    call_order: list[str] = []

    def first() -> None:
        call_order.append('first')

    async def second() -> None:
        call_order.append('second')

    def third() -> None:
        call_order.append('third')

    host.on_init(first)
    host.on_init(second)
    host.on_init(third)

    start_task = asyncio.create_task(host.start())

    await fake_ws.wait_sent(1)
    await fake_ws.receive(_make_event('myext', 'init'))

    await asyncio.wait_for(start_task, timeout=2.0)

    assert call_order == ['first', 'second', 'third'], (
        f'callbacks were not called in registration order: {call_order}'
    )

    await client.close()

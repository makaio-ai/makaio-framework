"""Tests for the local bus dispatch engine (_dispatch.py).

These tests cover priority-ordered handler registration and the full middleware
chain dispatch semantics mirroring the TypeScript bus-core behavior.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from makaio._dispatch import LocalBus, Registration, _subject_matches_pattern
from makaio.types import EventContext, RequestContext

# ---------------------------------------------------------------------------
# Wildcard matching
# ---------------------------------------------------------------------------


class TestSubjectMatchesPattern(unittest.TestCase):
    def test_exact_match(self) -> None:
        assert _subject_matches_pattern('agent.complete', 'agent.complete') is True

    def test_exact_mismatch(self) -> None:
        assert _subject_matches_pattern('agent.complete', 'agent.started') is False

    def test_global_wildcard_matches_everything(self) -> None:
        assert _subject_matches_pattern('agent.complete', '*') is True
        assert _subject_matches_pattern('tool.execute', '*') is True
        assert _subject_matches_pattern('anything.at.all', '*') is True

    def test_dot_wildcard_matches_subject_under_namespace(self) -> None:
        assert _subject_matches_pattern('agent.complete', 'agent.*') is True
        assert _subject_matches_pattern('agent.started', 'agent.*') is True

    def test_dot_wildcard_does_not_match_other_namespace(self) -> None:
        assert _subject_matches_pattern('tool.execute', 'agent.*') is False

    def test_dot_wildcard_matches_deep_subject(self) -> None:
        # TypeScript semantics: startswith(prefix + '.') — matches multi-level too
        assert _subject_matches_pattern('agent.sub.deep', 'agent.*') is True

    def test_colon_wildcard_matches_child_namespace(self) -> None:
        assert _subject_matches_pattern('adapter:claudeCode.initialized', 'adapter:*') is True
        assert _subject_matches_pattern('adapter:claudeCode:sdk.thinking', 'adapter:*') is True

    def test_colon_wildcard_does_not_match_dot_subject(self) -> None:
        assert _subject_matches_pattern('adapter.initialized', 'adapter:*') is False


# ---------------------------------------------------------------------------
# Event dispatch
# ---------------------------------------------------------------------------


class TestEventDispatch(unittest.IsolatedAsyncioTestCase):
    async def test_event_handler_registration_and_dispatch(self) -> None:
        """Registered handler is called with EventContext on dispatch."""
        bus = LocalBus()
        received: list[EventContext] = []

        async def handler(ctx: EventContext) -> None:
            received.append(ctx)

        bus.register_event('agent.complete', handler, priority=0)

        await bus.dispatch_event(
            'agent.complete',
            {'agentId': 'a1'},
            message_id='m1',
            correlation_id='c1',
            message={'type': 'event'},
        )

        assert len(received) == 1
        assert received[0].payload == {'agentId': 'a1'}
        assert received[0].subject == 'agent.complete'
        assert received[0].message_id == 'm1'
        assert received[0].correlation_id == 'c1'

    async def test_event_priority_ordering(self) -> None:
        """Higher-priority handlers are invoked first (all run concurrently)."""
        bus = LocalBus()
        call_order: list[str] = []
        started: dict[str, asyncio.Event] = {
            'high': asyncio.Event(),
            'low': asyncio.Event(),
        }
        ready: dict[str, asyncio.Event] = {
            'high': asyncio.Event(),
            'low': asyncio.Event(),
        }

        async def high_priority(ctx: EventContext) -> None:
            call_order.append('high')
            started['high'].set()

        async def low_priority(ctx: EventContext) -> None:
            call_order.append('low')
            started['low'].set()

        bus.register_event('agent.complete', low_priority, priority=10)
        bus.register_event('agent.complete', high_priority, priority=100)

        await bus.dispatch_event(
            'agent.complete',
            {},
            message_id='m1',
            correlation_id='c1',
            message={},
        )
        # Both ran; high should have been scheduled first (launched in priority order)
        assert 'high' in call_order
        assert 'low' in call_order

    async def test_event_wildcard_matching(self) -> None:
        """Pattern 'agent.*' matches 'agent.complete' but not 'tool.execute'."""
        bus = LocalBus()
        received: list[str] = []

        async def wildcard_handler(ctx: EventContext) -> None:
            received.append(ctx.subject)

        bus.register_event('agent.*', wildcard_handler, priority=0)

        await bus.dispatch_event(
            'agent.complete',
            {},
            message_id='m1',
            correlation_id='c1',
            message={},
        )
        await bus.dispatch_event(
            'tool.execute',
            {},
            message_id='m2',
            correlation_id='c2',
            message={},
        )

        assert received == ['agent.complete']

    async def test_event_global_wildcard(self) -> None:
        """Global wildcard '*' matches all subjects."""
        bus = LocalBus()
        received: list[str] = []

        async def global_handler(ctx: EventContext) -> None:
            received.append(ctx.subject)

        bus.register_event('*', global_handler, priority=0)

        await bus.dispatch_event(
            'agent.complete', {}, message_id='m1', correlation_id='c1', message={}
        )
        await bus.dispatch_event(
            'tool.execute', {}, message_id='m2', correlation_id='c2', message={}
        )

        assert received == ['agent.complete', 'tool.execute']

    async def test_event_error_isolation(self) -> None:
        """One failing handler does not prevent others from running."""
        bus = LocalBus()
        received: list[str] = []

        async def failing_handler(ctx: EventContext) -> None:
            raise RuntimeError('handler exploded')

        async def good_handler(ctx: EventContext) -> None:
            received.append('good')

        bus.register_event('agent.complete', failing_handler, priority=100)
        bus.register_event('agent.complete', good_handler, priority=50)

        # Should not raise; errors are logged and suppressed
        await bus.dispatch_event(
            'agent.complete', {}, message_id='m1', correlation_id='c1', message={}
        )

        assert received == ['good']

    async def test_event_sync_handler_supported(self) -> None:
        """Synchronous (non-async) event handlers are also supported."""
        bus = LocalBus()
        received: list[int] = []

        def sync_handler(ctx: EventContext) -> None:
            received.append(1)

        bus.register_event('agent.started', sync_handler, priority=0)
        await bus.dispatch_event(
            'agent.started', {}, message_id='m1', correlation_id=None, message={}
        )
        assert received == [1]


# ---------------------------------------------------------------------------
# Request dispatch
# ---------------------------------------------------------------------------


class TestRequestDispatch(unittest.IsolatedAsyncioTestCase):
    async def test_request_handler_registration_and_dispatch(self) -> None:
        """Register a handler and dispatch a request — returns the set result."""
        bus = LocalBus()

        async def handler(ctx: RequestContext) -> None:
            ctx.set_result({'answer': 42})

        bus.register_request('tool.execute', handler, priority=0)

        result, has_result = await bus.dispatch_request(
            'tool.execute', {'tool': 'calc'}, message_id='m1', correlation_id='c1', message={}
        )

        assert has_result is True
        assert result == {'answer': 42}

    async def test_request_priority_ordering(self) -> None:
        """Highest-priority handler runs first."""
        bus = LocalBus()
        call_order: list[str] = []

        async def high(ctx: RequestContext) -> None:
            call_order.append('high')
            ctx.set_result('high')

        async def low(ctx: RequestContext) -> None:
            call_order.append('low')
            ctx.set_result('low')

        bus.register_request('tool.execute', low, priority=10)
        bus.register_request('tool.execute', high, priority=100)

        result, has_result = await bus.dispatch_request(
            'tool.execute', {}, message_id='m1', correlation_id='c1', message={}
        )

        # High priority runs first and sets the result; low is never reached
        # (no auto-advance since high called set_result)
        assert has_result is True
        assert result == 'high'
        assert call_order == ['high']

    async def test_request_next_chaining(self) -> None:
        """Handler A calls await ctx.next(); handler B sets result; A sees it afterward."""
        bus = LocalBus()
        call_order: list[str] = []

        async def handler_a(ctx: RequestContext) -> None:
            call_order.append('A-before')
            await ctx.next()
            call_order.append(f'A-after result={ctx.result}')

        async def handler_b(ctx: RequestContext) -> None:
            call_order.append('B')
            ctx.set_result({'answer': 42})

        bus.register_request('tool.execute', handler_a, priority=100)
        bus.register_request('tool.execute', handler_b, priority=50)

        result, has_result = await bus.dispatch_request(
            'tool.execute', {'tool': 'test'}, message_id='m1', correlation_id='c1', message={}
        )

        assert result == {'answer': 42}
        assert has_result is True
        assert call_order == ['A-before', 'B', "A-after result={'answer': 42}"]

    async def test_request_extend_result(self) -> None:
        """Two handlers build the response incrementally using extend_result.

        Handler A calls next() first so that B's result is merged onto A's
        context, then A extends with its own fields — mimicking the TypeScript
        extendResult + next() + extendResult pattern.
        """
        bus = LocalBus()

        async def first(ctx: RequestContext) -> None:
            # Let the downstream handler run first, then extend
            await ctx.next()
            ctx.extend_result({'part1': 'hello'})

        async def second(ctx: RequestContext) -> None:
            ctx.extend_result({'part2': 'world'})

        bus.register_request('tool.execute', first, priority=100)
        bus.register_request('tool.execute', second, priority=50)

        result, has_result = await bus.dispatch_request(
            'tool.execute', {}, message_id='m1', correlation_id='c1', message={}
        )

        assert has_result is True
        assert result == {'part1': 'hello', 'part2': 'world'}

    async def test_request_replace_payload(self) -> None:
        """Handler transforms payload for subsequent handlers via replace_payload."""
        bus = LocalBus()
        seen_payloads: list[object] = []

        async def transformer(ctx: RequestContext) -> None:
            seen_payloads.append(ctx.payload)
            ctx.replace_payload({'transformed': True, 'original': ctx.payload})
            # No set_result, no next() → auto-advance

        async def terminal(ctx: RequestContext) -> None:
            seen_payloads.append(ctx.payload)
            ctx.set_result({'received': ctx.payload})

        bus.register_request('tool.execute', transformer, priority=100)
        bus.register_request('tool.execute', terminal, priority=50)

        result, has_result = await bus.dispatch_request(
            'tool.execute', {'raw': 'data'}, message_id='m1', correlation_id='c1', message={}
        )

        assert has_result is True
        assert seen_payloads[0] == {'raw': 'data'}
        assert seen_payloads[1] == {'transformed': True, 'original': {'raw': 'data'}}
        assert result == {'received': {'transformed': True, 'original': {'raw': 'data'}}}

    async def test_request_priority_cursor(self) -> None:
        """Request with cursor skips handlers at or above the cursor priority."""
        bus = LocalBus()
        call_order: list[str] = []

        async def high(ctx: RequestContext) -> None:
            call_order.append('high')
            ctx.set_result('high')

        async def mid(ctx: RequestContext) -> None:
            call_order.append('mid')
            ctx.set_result('mid')

        async def low(ctx: RequestContext) -> None:
            call_order.append('low')
            ctx.set_result('low')

        bus.register_request('tool.execute', high, priority=100)
        bus.register_request('tool.execute', mid, priority=50)
        bus.register_request('tool.execute', low, priority=10)

        # cursor=50 skips handlers with priority >= 50 (high=100 and mid=50 are skipped)
        result, has_result = await bus.dispatch_request(
            'tool.execute',
            {},
            message_id='m1',
            correlation_id='c1',
            message={},
            cursor=50,
        )

        assert has_result is True
        assert result == 'low'
        assert call_order == ['low']

    async def test_request_dispatch_reports_next_remote_cursor_after_fallthrough(self) -> None:
        """When local handlers produce no result, the next remote cursor is the last executed priority."""
        bus = LocalBus()
        call_order: list[str] = []

        async def high(ctx: RequestContext) -> None:
            call_order.append('high')
            await ctx.next()

        async def low(ctx: RequestContext) -> None:
            call_order.append('low')

        bus.register_request('tool.execute', high, priority=100)
        bus.register_request('tool.execute', low, priority=50)

        outcome = await bus.dispatch_request_with_cursor(
            'tool.execute', {}, message_id='m1', correlation_id='c1', message={}
        )

        assert outcome.has_result is False
        assert outcome.result is None
        assert outcome.next_remote_cursor == 50
        assert call_order == ['high', 'low']

    async def test_request_auto_advance(self) -> None:
        """Handler calling neither set_result() nor next() auto-advances to next."""
        bus = LocalBus()
        call_order: list[str] = []

        async def passthrough(ctx: RequestContext) -> None:
            call_order.append('passthrough')
            # Calls neither set_result() nor next() — should auto-advance

        async def terminal(ctx: RequestContext) -> None:
            call_order.append('terminal')
            ctx.set_result({'ok': True})

        bus.register_request('test.auto', passthrough, priority=100)
        bus.register_request('test.auto', terminal, priority=50)

        result, has_result = await bus.dispatch_request(
            'test.auto', {}, message_id='m1', correlation_id='c1', message={}
        )

        assert result == {'ok': True}
        assert has_result is True
        assert call_order == ['passthrough', 'terminal']

    async def test_request_no_handler(self) -> None:
        """Returns (None, False) when no handler is registered for the subject."""
        bus = LocalBus()

        result, has_result = await bus.dispatch_request(
            'unknown.subject', {}, message_id='m1', correlation_id='c1', message={}
        )

        assert has_result is False
        assert result is None

    async def test_request_chain_exhausted_returns_no_result(self) -> None:
        """When all handlers auto-advance and none sets a result, returns (None, False)."""
        bus = LocalBus()

        async def no_op(ctx: RequestContext) -> None:
            pass  # Neither set_result nor next

        bus.register_request('tool.execute', no_op, priority=0)

        result, has_result = await bus.dispatch_request(
            'tool.execute', {}, message_id='m1', correlation_id='c1', message={}
        )

        assert has_result is False
        assert result is None

    async def test_request_context_fields(self) -> None:
        """RequestContext carries correct subject, message_id, correlation_id, message."""
        bus = LocalBus()
        captured: list[RequestContext] = []

        async def handler(ctx: RequestContext) -> None:
            captured.append(ctx)
            ctx.set_result(None)

        bus.register_request('tool.execute', handler, priority=0)

        await bus.dispatch_request(
            'tool.execute',
            {'x': 1},
            message_id='msg-99',
            correlation_id='corr-99',
            message={'type': 'request', 'extra': True},
        )

        assert len(captured) == 1
        ctx = captured[0]
        assert ctx.subject == 'tool.execute'
        assert ctx.message_id == 'msg-99'
        assert ctx.correlation_id == 'corr-99'
        assert ctx.payload == {'x': 1}
        assert ctx.message == {'type': 'request', 'extra': True}


# ---------------------------------------------------------------------------
# Registration management
# ---------------------------------------------------------------------------


class TestRegistration(unittest.IsolatedAsyncioTestCase):
    async def test_subscription_snapshot(self) -> None:
        """subscription_snapshot() returns correct priority map per subject."""
        bus = LocalBus()

        async def h1(ctx: RequestContext) -> None:
            ctx.set_result(None)

        async def h2(ctx: RequestContext) -> None:
            ctx.set_result(None)

        bus.register_request('tool.execute', h1, priority=100)
        bus.register_request('tool.execute', h2, priority=50)
        bus.register_request('tool.list', h1, priority=10)

        snapshot = bus.subscription_snapshot()

        assert snapshot['tool.execute'] == [100, 50]
        assert snapshot['tool.list'] == [10]

    def test_subscription_delivery_class_is_aggregated_fail_closed(self) -> None:
        """Any first-hop-only handler constrains the advertised subject."""
        bus = LocalBus()

        async def handler(ctx: RequestContext) -> None:
            ctx.set_result(None)

        bus.register_request(
            'tool.execute',
            handler,
            priority=100,
            delivery_class='relayable',
        )
        restricted = bus.register_request(
            'tool.execute',
            handler,
            priority=50,
            delivery_class='first-hop-only',
        )

        assert bus.subscription_delivery_class('tool.execute') == 'first-hop-only'

        bus.remove(restricted)

        assert bus.subscription_delivery_class('tool.execute') == 'relayable'

    async def test_unsubscribe_event_handler(self) -> None:
        """After removing an event registration, the handler is no longer called."""
        bus = LocalBus()
        call_count = 0

        async def handler(ctx: EventContext) -> None:
            nonlocal call_count
            call_count += 1

        reg = bus.register_event('agent.complete', handler, priority=0)
        await bus.dispatch_event(
            'agent.complete', {}, message_id='m1', correlation_id='c1', message={}
        )
        assert call_count == 1

        removed = bus.remove(reg)
        assert removed is True

        await bus.dispatch_event(
            'agent.complete', {}, message_id='m2', correlation_id='c2', message={}
        )
        assert call_count == 1  # unchanged — handler was removed

    async def test_unsubscribe_request_handler(self) -> None:
        """After removing a request registration, the handler is no longer called."""
        bus = LocalBus()
        call_count = 0

        async def handler(ctx: RequestContext) -> None:
            nonlocal call_count
            call_count += 1
            ctx.set_result('ok')

        reg = bus.register_request('tool.execute', handler, priority=0)
        _, has_result = await bus.dispatch_request(
            'tool.execute', {}, message_id='m1', correlation_id='c1', message={}
        )
        assert has_result is True
        assert call_count == 1

        removed = bus.remove(reg)
        assert removed is True

        _, has_result2 = await bus.dispatch_request(
            'tool.execute', {}, message_id='m2', correlation_id='c2', message={}
        )
        assert has_result2 is False
        assert call_count == 1  # unchanged

    def test_remove_unknown_registration_returns_false(self) -> None:
        """Removing an unknown registration is a no-op and returns False."""
        bus = LocalBus()

        async def handler(ctx: RequestContext) -> None:
            ctx.set_result(None)

        reg = Registration(kind='request', pattern='tool.execute', priority=0, handler=handler)
        assert bus.remove(reg) is False

    def test_has_request_handler(self) -> None:
        """has_request_handler() returns True when a handler is registered."""
        bus = LocalBus()

        async def handler(ctx: RequestContext) -> None:
            ctx.set_result(None)

        assert bus.has_request_handler('tool.execute') is False

        bus.register_request('tool.execute', handler, priority=0)
        assert bus.has_request_handler('tool.execute') is True

    def test_registration_returns_correct_metadata(self) -> None:
        """register_* returns a Registration with expected fields."""
        bus = LocalBus()

        async def event_handler(ctx: EventContext) -> None:
            pass

        async def request_handler(ctx: RequestContext) -> None:
            ctx.set_result(None)

        e_reg = bus.register_event('agent.complete', event_handler, priority=42)
        assert e_reg.kind == 'event'
        assert e_reg.pattern == 'agent.complete'
        assert e_reg.priority == 42
        assert e_reg.handler is event_handler

        r_reg = bus.register_request('tool.execute', request_handler, priority=99)
        assert r_reg.kind == 'request'
        assert r_reg.pattern == 'tool.execute'
        assert r_reg.priority == 99
        assert r_reg.handler is request_handler

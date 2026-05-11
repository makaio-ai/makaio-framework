"""Local bus dispatch engine.

Priority-ordered handler registry and dispatch engine. Ports the TypeScript
``bus-core`` dispatch semantics to Python: a pure in-process registry with no
transport coupling.

Handler chain semantics (ported from ``bus-core/src/methods/request/dispatch.ts``):

- Handlers are sorted by priority descending.
- A handler that calls ``ctx.set_result()`` stops the auto-advance.
- A handler that calls ``await ctx.next()`` explicitly delegates to the next
  handler and stops the auto-advance.
- A handler that calls neither auto-advances to the next handler.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from makaio.types import (
    EventContext,
    EventHandlerFn,
    RequestContext,
    RequestHandlerFn,
)

LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass
class Registration:
    """Handle returned by register methods; used to unsubscribe.

    @param kind: Either ``'event'`` or ``'request'``.
    @param pattern: The subject pattern or full subject this registration covers.
    @param priority: Numeric dispatch priority (higher runs first).
    @param handler: The registered handler callable.
    """

    kind: Literal['event', 'request']
    pattern: str
    priority: int
    handler: Any


@dataclass(frozen=True)
class RequestDispatchOutcome:
    """Result of dispatching through local request handlers.

    @param result: Handler result value, or ``None`` when unhandled.
    @param has_result: Whether a handler produced a result.
    @param next_remote_cursor: Priority cursor for a remote continuation after
        local fallthrough. ``None`` means no local handler ran.
    """

    result: Any
    has_result: bool
    next_remote_cursor: float | int | None


# ---------------------------------------------------------------------------
# Wildcard matching (mirrors TypeScript matchesSubscription)
# ---------------------------------------------------------------------------


def _subject_matches_pattern(subject: str, pattern: str) -> bool:
    """Return ``True`` when *subject* matches *pattern*.

    Supported pattern forms:

    - ``'*'`` — global wildcard, matches everything.
    - ``'<prefix>.*'`` — subject wildcard; matches subjects that start with
      ``<prefix>.`` (e.g. ``'agent.*'`` matches ``'agent.complete'``).
    - ``'<prefix>:*'`` — namespace wildcard; matches subjects that start with
      ``<prefix>:`` (e.g. ``'adapter:*'`` matches
      ``'adapter:claudeCode.initialized'``).
    - Exact string — matches only when ``subject == pattern``.

    @param subject: Full subject string to test (e.g. ``'agent.complete'``).
    @param pattern: Subscription pattern to match against.
    @returns: ``True`` if *subject* matches *pattern*, ``False`` otherwise.
    """
    if pattern == '*':
        return True
    if not pattern.endswith('*'):
        return subject == pattern
    if pattern.endswith(':*'):
        prefix = pattern[:-2]
        return subject.startswith(f'{prefix}:')
    if pattern.endswith('.*'):
        prefix = pattern[:-2]
        return subject.startswith(f'{prefix}.')
    return False


# ---------------------------------------------------------------------------
# Handler entry type
# ---------------------------------------------------------------------------


@dataclass
class HandlerEntry:
    """Single registered handler with its priority.

    @param priority: Numeric priority (higher = runs first).
    @param registration: The owning ``Registration`` object (used for removal).
    @param handler: The callable to invoke.
    """

    priority: int
    registration: Registration
    handler: EventHandlerFn | RequestHandlerFn


# ---------------------------------------------------------------------------
# LocalBus
# ---------------------------------------------------------------------------


class LocalBus:
    """Priority-ordered local handler registry and dispatch engine.

    Implements the same dispatch semantics as TypeScript's ``bus-core`` but
    without any transport coupling — all handlers live in the same process.

    Event dispatch:
        All matching handlers (exact + wildcard patterns) are collected, sorted
        by priority descending, and launched concurrently via
        ``asyncio.gather``. Errors from individual handlers are logged and
        suppressed so that one failing handler never blocks others.

    Request dispatch:
        Handlers are walked in priority order. Each handler receives a
        ``RequestContext``. If a handler calls ``set_result()``, the chain
        stops. If it calls ``await ctx.next()``, the next handler runs and the
        result propagates back. If it calls neither, the engine auto-advances
        to the next handler in the chain.
    """

    def __init__(self) -> None:
        # event handlers: pattern → sorted list of HandlerEntry (desc priority)
        self._event_handlers: dict[str, list[HandlerEntry]] = {}
        # request handlers: full subject → sorted list of HandlerEntry (desc priority)
        self._request_handlers: dict[str, list[HandlerEntry]] = {}

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register_event(
        self,
        pattern: str,
        handler: EventHandlerFn,
        *,
        priority: int = 0,
    ) -> Registration:
        """Register an event handler for *pattern*.

        @param pattern: Subject pattern (exact, ``'*'``, or ``'prefix.*'`` /
            ``'prefix:*'``).
        @param handler: Async or sync callable accepting ``EventContext``.
        @param priority: Dispatch priority; higher values run first.
        @returns: A ``Registration`` handle that can be passed to ``remove()``.
        """
        reg = Registration(kind='event', pattern=pattern, priority=priority, handler=handler)
        entry = HandlerEntry(priority=priority, registration=reg, handler=handler)
        entries = self._event_handlers.setdefault(pattern, [])
        _insert_sorted(entries, entry)
        return reg

    def register_request(
        self,
        full_subject: str,
        handler: RequestHandlerFn,
        *,
        priority: int,
    ) -> Registration:
        """Register a request handler for *full_subject*.

        @param full_subject: Exact subject string (e.g. ``'tool.execute'``).
        @param handler: Async or sync callable accepting ``RequestContext``.
        @param priority: Dispatch priority; higher values run first.
        @returns: A ``Registration`` handle that can be passed to ``remove()``.
        """
        reg = Registration(
            kind='request', pattern=full_subject, priority=priority, handler=handler
        )
        entry = HandlerEntry(priority=priority, registration=reg, handler=handler)
        entries = self._request_handlers.setdefault(full_subject, [])
        _insert_sorted(entries, entry)
        return reg

    def remove(self, registration: Registration) -> bool:
        """Remove a previously registered handler.

        @param registration: The ``Registration`` object returned by
            ``register_event`` or ``register_request``.
        @returns: ``True`` if the handler was found and removed, ``False`` if
            it was not present.
        """
        store = (
            self._event_handlers
            if registration.kind == 'event'
            else self._request_handlers
        )
        entries = store.get(registration.pattern)
        if entries is None:
            return False

        original_len = len(entries)
        store[registration.pattern] = [e for e in entries if e.registration is not registration]
        removed = len(store[registration.pattern]) < original_len

        if not store[registration.pattern]:
            del store[registration.pattern]

        return removed

    def subscription_snapshot(self) -> dict[str, list[int]]:
        """Return a priority map for all registered request subjects.

        @returns: Mapping from full subject to list of registered priorities
            (descending), suitable for advertising to remote peers.
        """
        return {
            subject: [e.priority for e in entries]
            for subject, entries in self._request_handlers.items()
        }

    def has_request_handler(self, full_subject: str) -> bool:
        """Return whether any request handler is registered for *full_subject*.

        @param full_subject: Exact subject to query.
        @returns: ``True`` if at least one handler is registered.
        """
        return bool(self._request_handlers.get(full_subject))

    def collect_matching_event_entries(self, full_subject: str) -> list[HandlerEntry]:
        """Return all event handler entries matching *full_subject*, sorted by priority desc.

        @param full_subject: Exact incoming event subject to match against all patterns.
        @returns: Priority-sorted list of matching :class:`HandlerEntry` objects.
        """
        matching: list[HandlerEntry] = []
        for pattern, entries in self._event_handlers.items():
            if _subject_matches_pattern(full_subject, pattern):
                matching.extend(entries)
        matching.sort(key=lambda e: e.priority, reverse=True)
        return matching

    def priorities_for(self, full_subject: str) -> list[int]:
        """Return the priority list for request handlers on *full_subject*.

        @param full_subject: Exact subject to query.
        @returns: List of registered priorities in descending order.
        """
        entries = self._request_handlers.get(full_subject, [])
        return [e.priority for e in entries]

    def has_any_handler(self, full_subject: str) -> bool:
        """Return whether any handler (event or request) is registered for *full_subject*.

        @param full_subject: Exact subject to check.
        @returns: ``True`` if at least one handler remains registered.
        """
        return bool(
            self._event_handlers.get(full_subject)
            or self._request_handlers.get(full_subject)
        )

    def event_patterns(self) -> list[str]:
        """Return all registered event patterns in sorted order.

        @returns: Sorted list of pattern strings currently registered.
        """
        return sorted(self._event_handlers.keys())

    # ------------------------------------------------------------------
    # Event dispatch
    # ------------------------------------------------------------------

    async def dispatch_event(
        self,
        full_subject: str,
        payload: Any,
        *,
        message_id: str,
        correlation_id: str | None,
        message: Mapping[str, Any],
    ) -> None:
        """Dispatch an event to all matching handlers concurrently.

        Collects all event handlers whose registration pattern matches
        *full_subject*, sorts by priority descending, and launches them all
        as concurrent tasks via ``asyncio.gather``. Errors are logged and
        isolated — one failing handler does not prevent others from running.

        @param full_subject: Exact event subject (e.g. ``'agent.complete'``).
        @param payload: Event payload passed to handlers.
        @param message_id: Unique identifier for this message.
        @param correlation_id: Optional correlation identifier.
        @param message: Full raw message envelope for context.
        """
        ctx = EventContext(
            payload=payload,
            subject=full_subject,
            message_id=message_id,
            correlation_id=correlation_id,
            message=message,
        )

        matching = self.collect_matching_event_entries(full_subject)
        if not matching:
            return

        await asyncio.gather(*(invoke_event_handler(e.handler, ctx) for e in matching))

    # ------------------------------------------------------------------
    # Request dispatch
    # ------------------------------------------------------------------

    async def dispatch_request(
        self,
        full_subject: str,
        payload: Any,
        *,
        message_id: str,
        correlation_id: str,
        message: Mapping[str, Any] | None = None,
        cursor: float | int | None = None,
    ) -> tuple[Any, bool]:
        """Dispatch a request through the priority-ordered handler chain.

        Walks all handlers registered for *full_subject* in priority-descending
        order. The chain respects the following semantics:

        - ``ctx.set_result(v)`` — records the result and stops auto-advance.
        - ``await ctx.next()`` — delegates to the next handler; result
          propagates back.
        - Neither called — auto-advances to the next handler.

        When *cursor* is provided, all handlers with ``priority >= cursor`` are
        skipped so that a remote hop can continue from exactly where the
        originating node left off.

        @param full_subject: Exact request subject (e.g. ``'tool.execute'``).
        @param payload: Request payload.
        @param message_id: Unique message identifier.
        @param correlation_id: Correlation identifier.
        @param message: Optional raw message envelope.
        @param cursor: Optional priority cursor; handlers at or above this
            value are skipped.
        @returns: ``(result_value, has_result)`` tuple. When no handler
            produces a result, returns ``(None, False)``.
        """
        outcome = await self.dispatch_request_with_cursor(
            full_subject,
            payload,
            message_id=message_id,
            correlation_id=correlation_id,
            message=message,
            cursor=cursor,
        )
        return (outcome.result, outcome.has_result)

    async def dispatch_request_with_cursor(
        self,
        full_subject: str,
        payload: Any,
        *,
        message_id: str,
        correlation_id: str,
        message: Mapping[str, Any] | None = None,
        cursor: float | int | None = None,
    ) -> RequestDispatchOutcome:
        """Dispatch a request and report the remote continuation cursor.

        The continuation cursor is the lowest-priority local handler that ran.
        A remote bus can use it to skip handlers at or above that priority
        after local fallthrough, preserving priority ordering across nodes.

        @param full_subject: Exact request subject.
        @param payload: Request payload.
        @param message_id: Unique message identifier.
        @param correlation_id: Correlation identifier.
        @param message: Optional raw message envelope.
        @param cursor: Optional inbound priority cursor.
        @returns: Full dispatch outcome including the remote cursor.
        """
        if message is None:
            message = {}

        # Build the handler chain for this subject
        chain = self._build_request_chain(full_subject, cursor)
        if not chain:
            return RequestDispatchOutcome(
                result=None,
                has_result=False,
                next_remote_cursor=None,
            )

        executed_priorities: list[float | int] = []
        result, has_result = await _step_dispatch(
            chain=chain,
            index=0,
            payload=payload,
            full_subject=full_subject,
            message_id=message_id,
            correlation_id=correlation_id,
            message=message,
            executed_priorities=executed_priorities,
        )
        return RequestDispatchOutcome(
            result=result,
            has_result=has_result,
            next_remote_cursor=min(executed_priorities) if executed_priorities else None,
        )

    def _build_request_chain(
        self,
        full_subject: str,
        cursor: float | int | None,
    ) -> list[HandlerEntry]:
        """Return the ordered handler chain for *full_subject*.

        Collects handlers registered under the exact subject key (request
        handlers do not support wildcard patterns — only exact matches), sorts
        by priority descending, then applies the cursor filter.

        @param full_subject: Exact subject to look up.
        @param cursor: Optional priority cursor; entries at or above this
            value are excluded.
        @returns: Ordered list of handler entries to execute.
        """
        entries = self._request_handlers.get(full_subject, [])
        # entries are already sorted desc by _insert_sorted
        if cursor is None:
            return list(entries)
        return [e for e in entries if e.priority < cursor]


# ---------------------------------------------------------------------------
# Step dispatch (free function to avoid self-reference in closures)
# ---------------------------------------------------------------------------


async def _step_dispatch(
    *,
    chain: list[HandlerEntry],
    index: int,
    payload: Any,
    full_subject: str,
    message_id: str,
    correlation_id: str,
    message: Mapping[str, Any],
    executed_priorities: list[float | int],
) -> tuple[Any, bool]:
    """Execute one step in the request handler chain.

    Mirrors ``stepDispatch`` / ``executeLocalEntry`` from TypeScript
    ``bus-core/src/methods/request/dispatch.ts``.

    ``RequestContext`` uses ``__slots__`` so its methods cannot be replaced.
    Instead we:

    1. Set ``ctx._next_fn`` to a tracking wrapper — ``ctx.next()`` clears
       ``_next_fn`` before calling, so we detect the call by checking whether
       the wrapper was invoked (via ``_next_called``).
    2. After the handler returns we read ``ctx._has_result`` / ``ctx._result``
       / ``ctx._payload`` directly (all are ``__slots__`` attributes and are
       fully accessible from Python).

    @param chain: Full ordered handler list for this request.
    @param index: Current position in *chain*.
    @param payload: Current request payload (may have been replaced by a prior
        handler via ``ctx.replace_payload``).
    @param full_subject: Subject string, threaded for ``RequestContext``.
    @param message_id: Message identifier.
    @param correlation_id: Correlation identifier.
    @param message: Raw message envelope.
    @param executed_priorities: Mutable list recording each local priority that
        ran during this dispatch.
    @returns: ``(result_value, has_result)`` tuple.
    """
    if index >= len(chain):
        return (None, False)

    entry = chain[index]
    executed_priorities.append(entry.priority)

    ctx: RequestContext[Any, Any] = RequestContext(
        payload=payload,
        subject=full_subject,
        message_id=message_id,
        correlation_id=correlation_id,
        message=message,
    )

    # --- next() tracking ---------------------------------------------------
    # We use a single-element list as a mutable flag so the inner coroutine
    # and the outer coroutine share state without a nonlocal dance.
    next_called: list[bool] = [False]

    async def _next_wrapper() -> None:
        """Wrapper that marks next() as called, then advances the chain.

        ``_advance`` reads ``ctx._payload`` at call time so any
        ``replace_payload`` calls made before ``next()`` are propagated, and
        merges the downstream result back onto *ctx* if one was produced.
        """
        next_called[0] = True
        await _advance(
            chain,
            index,
            ctx,
            full_subject,
            message_id,
            correlation_id,
            message,
            executed_priorities,
        )

    ctx._next_fn = _next_wrapper  # type: ignore[assignment]

    # --- invoke handler ----------------------------------------------------
    invocation = entry.handler(ctx)
    if inspect.isawaitable(invocation):
        await invocation

    # --- post-handler auto-advance logic -----------------------------------
    # Mirror TypeScript:
    #   if (nextPromise !== undefined)  → await it (already done above)
    #   else if (!hasResult)            → stepDispatch(nextIndex)  [auto-advance]
    #
    # ``ctx.next()`` clears _next_fn before calling the wrapper, so after the
    # handler returns _next_fn is None if next() was ever called.  We use our
    # explicit flag (next_called[0]) for clarity instead of inspecting _next_fn.
    if not next_called[0] and not ctx._has_result:  # type: ignore[attr-defined]
        # Auto-advance: handler called neither set_result() nor next()
        outcome_value, outcome_handled = await _step_dispatch(
            chain=chain,
            index=index + 1,
            payload=ctx._payload,  # type: ignore[attr-defined]
            full_subject=full_subject,
            message_id=message_id,
            correlation_id=correlation_id,
            message=message,
            executed_priorities=executed_priorities,
        )
        if outcome_handled:
            ctx.set_result(outcome_value)

    return (ctx._result, ctx._has_result)  # type: ignore[attr-defined]


async def _advance(
    chain: list[HandlerEntry],
    index: int,
    ctx: RequestContext[Any, Any],
    full_subject: str,
    message_id: str,
    correlation_id: str,
    message: Mapping[str, Any],
    executed_priorities: list[float | int],
) -> None:
    """Advance to the next handler in the chain and merge its result onto *ctx*.

    Called from the ``_next_wrapper`` installed on ``ctx._next_fn``.  Reads
    ``ctx._payload`` at call time so that any ``replace_payload`` call made
    before ``next()`` is propagated forward.

    @param chain: Full handler chain.
    @param index: Index of the *current* handler (the next step is ``index+1``).
    @param ctx: Caller's ``RequestContext``; result is merged here if the
        downstream step produces one and the caller has not set a result yet.
    @param full_subject: Subject string threaded through for context creation.
    @param message_id: Message identifier.
    @param correlation_id: Correlation identifier.
    @param message: Raw message envelope.
    @param executed_priorities: Mutable list recording each local priority that
        ran during this dispatch.
    """
    outcome_value, outcome_handled = await _step_dispatch(
        chain=chain,
        index=index + 1,
        payload=ctx._payload,  # type: ignore[attr-defined]
        full_subject=full_subject,
        message_id=message_id,
        correlation_id=correlation_id,
        message=message,
        executed_priorities=executed_priorities,
    )
    if outcome_handled and not ctx._has_result:  # type: ignore[attr-defined]
        ctx.set_result(outcome_value)


# ---------------------------------------------------------------------------
# Public event-handler invocation helper
# ---------------------------------------------------------------------------


async def invoke_event_handler(handler: EventHandlerFn, ctx: EventContext[Any]) -> None:
    """Invoke a single event handler, awaiting if async. Exceptions are logged and suppressed.

    @param handler: The event handler callable to invoke.
    @param ctx: The :class:`~makaio.types.EventContext` to pass to the handler.
    """
    try:
        result = handler(ctx)
        if inspect.isawaitable(result):
            await result
    except Exception:
        LOGGER.exception('Event handler for %s failed', ctx.subject)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _insert_sorted(entries: list[HandlerEntry], entry: HandlerEntry) -> None:
    """Insert *entry* into *entries* maintaining descending priority order.

    Uses bisect-style insertion to keep the list sorted without a full sort
    on every registration.

    @param entries: List to insert into (sorted descending by priority).
    @param entry: The new entry to insert.
    """
    lo, hi = 0, len(entries)
    while lo < hi:
        mid = (lo + hi) // 2
        if entries[mid].priority >= entry.priority:
            lo = mid + 1
        else:
            hi = mid
    entries.insert(lo, entry)

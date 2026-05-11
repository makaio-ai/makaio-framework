"""Async Makaio bus protocol client.

Composition root that wires :class:`~makaio._dispatch.LocalBus`,
:class:`~makaio._transport.Transport`, and HMAC authentication into
the public :class:`BusClient` API.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from collections.abc import Awaitable, Mapping
from typing import Any, Literal

from makaio._auth import normalize_bus_secret, probe_health, run_auth_handshake
from makaio._dispatch import (
    LocalBus,
    Registration,
    invoke_event_handler,
)
from makaio._serialization import from_wire, to_wire
from makaio._transport import StdioTransport, Transport, WebSocketTransport
from makaio.types import (
    EventContext,
    EventHandlerFn,
    EventSubject,
    IdFactory,
    JSONValue,
    OnceTimeoutError,
    RequestTimeoutError,
    RequestContext,
    RequestHandlerFn,
    RequestSubject,
    SubjectLike,
    WebSocketFactory,
    WildcardSubject,
)

__all__ = ["BusClient", "BusError", "Subscription"]

LOGGER = logging.getLogger(__name__)

_DEFAULT_URL = "ws://127.0.0.1:6252/bus"


# ---------------------------------------------------------------------------
# BusError
# ---------------------------------------------------------------------------


class BusError(RuntimeError):
    """Structured error returned by a remote Makaio bus participant.

    @param message: Human-readable error description.
    @param code: Machine-readable error code (e.g. ``"NO_HANDLER"``).
    @param subject: The bus subject that produced the error.
    @param data: Optional extra data attached to the error.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        subject: str | None = None,
        data: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.subject = subject
        self.data = dict(data or {})

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "BusError":
        """Create a :class:`BusError` from a wire error payload dict.

        @param payload: The ``error`` field of an inbound response message.
        @returns: A populated :class:`BusError` instance.
        """
        message = payload.get("message")
        if not isinstance(message, str):
            message = "Makaio bus request failed"

        data = payload.get("data")
        return cls(
            message,
            code=payload.get("code") if isinstance(payload.get("code"), str) else None,
            subject=(
                payload.get("subject")
                if isinstance(payload.get("subject"), str)
                else None
            ),
            data=data if isinstance(data, Mapping) else None,
        )

    def to_payload(self) -> dict[str, Any]:
        """Serialize this error into the Makaio bus wire error envelope.

        @returns: A dict suitable for embedding as the ``error`` field in a
            response message.
        """
        payload: dict[str, Any] = {"message": self.message}
        if self.code is not None:
            payload["code"] = self.code
        if self.subject is not None:
            payload["subject"] = self.subject
        if self.data:
            payload["data"] = self.data
        return payload


# ---------------------------------------------------------------------------
# Subscription
# ---------------------------------------------------------------------------


class Subscription:
    """Handle returned by :meth:`BusClient.subscribe` and
    :meth:`BusClient.on_request`.

    @param client: The owning :class:`BusClient`.
    @param full_subject: The full subject or pattern this subscription covers.
    @param registration: The :class:`~makaio._dispatch.Registration` returned
        by the local bus registry.
    @param request: Whether this is a request handler subscription.
    """

    def __init__(
        self,
        client: "BusClient",
        full_subject: str,
        registration: Registration,
        *,
        request: bool,
    ) -> None:
        self._client = client
        self._full_subject = full_subject
        self._registration = registration
        self._request = request
        self._closed = False

    async def close(self) -> None:
        """Remove this handler from the local bus and update remote
        subscription state.
        """
        if self._closed:
            return

        self._closed = True
        await self._client._remove_subscription(
            self._full_subject,
            self._registration,
            request=self._request,
        )


# ---------------------------------------------------------------------------
# BusClient
# ---------------------------------------------------------------------------


class BusClient:
    """Async Makaio bus client.

    Wires a :class:`~makaio._dispatch.LocalBus` (in-process handler registry
    and dispatch engine) with a
    :class:`~makaio._transport.Transport` (wire I/O) and optional
    HMAC authentication.

    @param url: WebSocket bus URL. Defaults to the ``MAKAIO_BUS_URL``
        environment variable, then ``ws://127.0.0.1:6252/bus``.
    @param dispatch: Dispatch strategy. ``"local-first"`` tries local handlers
        before forwarding to the remote bus; ``"remote"`` always sends over
        the transport.
    @param auth: Authentication mode. ``None`` (default) auto-probes the
        server; ``True`` forces HMAC auth; ``False`` skips it.
    @param auto_reconnect: Reopen the transport once after an unexpected drop
        and replay local subscriptions.
    @param connect_timeout_ms: Connection timeout in milliseconds.
    @param debug: Enable debug logging when ``True``.
    @param websocket_factory: Optional factory to create the WebSocket
        connection. Injected for testing.
    @param id_factory: Optional factory for unique message IDs.
    """

    def __init__(
        self,
        url: str | None = None,
        *,
        dispatch: Literal["local-first", "remote"] = "local-first",
        auth: bool | None = None,
        auto_reconnect: bool = False,
        connect_timeout_ms: float = 5_000,
        debug: bool | None = None,
        websocket_factory: WebSocketFactory | None = None,
        id_factory: IdFactory | None = None,
    ) -> None:
        self.url: str = url or os.environ.get("MAKAIO_BUS_URL", _DEFAULT_URL)
        self._dispatch = dispatch
        self._auth_mode = auth
        self._auto_reconnect = auto_reconnect
        self._connect_timeout_ms = connect_timeout_ms
        self._websocket_factory = websocket_factory
        self._transport_factory: Any | None = None
        self._id_factory: IdFactory = id_factory or (lambda: uuid.uuid4().hex)
        self._bus = LocalBus()
        self._transport: Transport | None = None
        self._event_payload_types: dict[str, type[Any]] = {}
        self._request_types: dict[str, type[Any]] = {}
        self._response_types: dict[str, type[Any]] = {}
        self._connection_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._readiness_future: asyncio.Future[None] | None = None
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._pending: dict[str, asyncio.Future[JSONValue]] = {}
        self._closed = False

        if debug:
            logging.getLogger("makaio").setLevel(logging.DEBUG)

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    @classmethod
    def from_stdio(
        cls,
        *,
        input_stream: Any | None = None,
        output_stream: Any | None = None,
        dispatch: Literal["local-first", "remote"] = "local-first",
        connect_timeout_ms: float = 5_000,
        debug: bool | None = None,
        id_factory: IdFactory | None = None,
    ) -> "BusClient":
        """Create a bus client that communicates over stdin/stdout JSON lines.

        @param input_stream: Optional async stream exposing ``readline()``.
        @param output_stream: Optional stream exposing ``write()``.
        @param dispatch: Dispatch strategy.
        @param connect_timeout_ms: Connection timeout in milliseconds.
        @param debug: Enable debug logging when ``True``.
        @param id_factory: Optional factory for unique message IDs.
        @returns: A :class:`BusClient` configured with stdio transport.
        """
        client = cls(
            "stdio://local",
            dispatch=dispatch,
            auth=False,
            connect_timeout_ms=connect_timeout_ms,
            debug=debug,
            id_factory=id_factory,
        )
        client._transport_factory = lambda: StdioTransport(input_stream, output_stream)
        return client

    async def connect(self) -> None:
        """Open the transport connection and replay local subscriptions.

        @raises RuntimeError: If the client has already been closed.
        """
        if self._closed:
            raise RuntimeError("BusClient has been closed")
        async with self._connection_lock:
            if self._transport is not None:
                return
            await self._open_connection_with_timeout()

    async def reconnect(self) -> None:
        """Reopen the transport connection and replay local subscriptions.

        @raises RuntimeError: If the client has already been closed.
        """
        if self._closed:
            raise RuntimeError("BusClient has been closed")
        async with self._connection_lock:
            await self._reset_connection("Makaio bus connection closed")
            await self._open_connection_with_timeout()

    async def close(self) -> None:
        """Close the transport and fail any pending requests."""
        async with self._connection_lock:
            self._closed = True
            await self._reset_connection("Makaio bus connection closed")

    # ------------------------------------------------------------------
    # Public API — event subscription
    # ------------------------------------------------------------------

    async def subscribe(
        self,
        subject: SubjectLike,
        handler: EventHandlerFn,
        priority: int = 0,
    ) -> Subscription:
        """Register a local event handler and advertise the subscription.

        @param subject: Event subject — an :class:`~makaio.types.EventSubject`,
            :class:`~makaio.types.WildcardSubject`, or plain ``str``.
        @param handler: Async or sync callable accepting an
            :class:`~makaio.types.EventContext`.
        @param priority: Dispatch priority (higher runs first). Unused for
            events dispatched concurrently but included for consistency.
        @returns: A :class:`Subscription` handle with a ``close()`` method.
        """
        full_subject = _resolve_subject(subject)
        _ensure_supported_subscription_pattern(full_subject)
        self._remember_subject_types(subject)
        async with self._connection_lock:
            registration = self._bus.register_event(
                full_subject, handler, priority=priority
            )
            try:
                await self._send_subscribe_snapshot()
            except Exception:
                self._bus.remove(registration)
                raise
        return Subscription(self, full_subject, registration, request=False)

    async def on_request(
        self,
        subject: SubjectLike,
        handler: RequestHandlerFn,
        priority: int = 0,
    ) -> Subscription:
        """Register a local request handler and advertise its priority.

        @param subject: Request subject — a
            :class:`~makaio.types.RequestSubject` or plain ``str``. Wildcards
            are not permitted.
        @param handler: Async or sync callable accepting a
            :class:`~makaio.types.RequestContext`.
        @param priority: Dispatch priority for the handler chain.
        @returns: A :class:`Subscription` handle with a ``close()`` method.
        """
        full_subject = _resolve_subject(subject)
        _ensure_exact_subject(full_subject)
        self._remember_subject_types(subject)
        async with self._connection_lock:
            registration = self._bus.register_request(
                full_subject, handler, priority=priority
            )
            try:
                await self._send_subscribe_snapshot()
            except Exception:
                self._bus.remove(registration)
                raise
        return Subscription(self, full_subject, registration, request=True)

    # ------------------------------------------------------------------
    # Public API — messaging
    # ------------------------------------------------------------------

    async def emit(
        self,
        subject: SubjectLike | str,
        payload: JSONValue,
        *,
        namespace: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Emit an event payload to the bus.

        @param subject: Full event subject string or typed descriptor.
        @param payload: Event payload value to transmit.
        @param namespace: Optional namespace override (legacy positional
            splitting is used when omitted).
        @param correlation_id: Optional correlation identifier to attach.
        """
        full_subject = _resolve_subject(subject)
        _ensure_exact_subject(full_subject, namespace=namespace)
        wire_payload = to_wire(payload)
        ns, subject_name = _split_subject(full_subject, namespace=namespace)
        message: dict[str, Any] = {
            "type": "event",
            "namespace": ns,
            "subject": subject_name,
            "payload": wire_payload,
            "messageId": self._new_id(),
        }
        if correlation_id is not None:
            message["correlationId"] = correlation_id
        if self._dispatch == "local-first":
            await self._bus.dispatch_event(
                full_subject,
                payload,
                message_id=message["messageId"],
                correlation_id=correlation_id,
                message=message,
            )
        await self._send(message)

    async def request(
        self,
        subject: SubjectLike | str,
        payload: JSONValue,
        *,
        namespace: str | None = None,
        timeout: float | int | None = None,
        priority: int | None = None,
        deadline: float | int | None = None,
        timeout_ms: float | None = None,
    ) -> JSONValue:
        """Send a request and wait for one response.

        If ``dispatch`` is ``"local-first"`` and a local handler is registered
        for *subject*, the request is handled in-process without a round-trip.
        Otherwise it is forwarded over the transport.

        @param subject: Request subject — a
            :class:`~makaio.types.RequestSubject` or plain ``str``.
        @param payload: Request payload value.
        @param namespace: Optional namespace override.
        @param timeout: Wire-level timeout hint (forwarded to the server).
        @param priority: Priority cursor for remote dispatch continuation.
        @param deadline: Absolute deadline hint forwarded to the server.
        @param timeout_ms: Local asyncio wait timeout in milliseconds.
        @returns: The response payload value.
        @raises BusError: If the server returns an error response.
        @raises RequestTimeoutError: If ``timeout_ms`` elapses before a response.
        """
        full_subject = _resolve_subject(subject)
        _ensure_exact_subject(full_subject, namespace=namespace)
        self._remember_subject_types(subject)
        dispatch_payload = payload
        wire_payload = to_wire(payload)
        request_type = self._request_types.get(full_subject)
        if request_type is not None and isinstance(payload, Mapping):
            dispatch_payload = from_wire(dict(payload), request_type)
        loop = asyncio.get_running_loop()
        deadline_at = loop.time() + timeout_ms / 1000.0 if timeout_ms is not None else None

        # Local-first dispatch: try local handler first
        remote_priority = priority
        if self._dispatch == "local-first":
            correlation_id = self._new_id()
            message_id = self._new_id()
            local_dispatch = self._bus.dispatch_request_with_cursor(
                full_subject,
                dispatch_payload,
                message_id=message_id,
                correlation_id=correlation_id,
                cursor=priority,
            )
            if deadline_at is None:
                outcome = await local_dispatch
            else:
                remaining = deadline_at - loop.time()
                if remaining <= 0:
                    raise RequestTimeoutError(full_subject, timeout_ms)
                try:
                    outcome = await asyncio.wait_for(local_dispatch, timeout=remaining)
                except asyncio.TimeoutError:
                    raise RequestTimeoutError(full_subject, timeout_ms)
            if outcome.has_result:
                response_type = self._response_types.get(full_subject)
                if response_type is not None and isinstance(outcome.result, dict):
                    return from_wire(outcome.result, response_type)
                return outcome.result
            if outcome.next_remote_cursor is not None:
                remote_priority = outcome.next_remote_cursor

        # Remote dispatch via transport
        ns, subject_name = _split_subject(full_subject, namespace=namespace)
        correlation_id = self._new_id()
        if deadline_at is not None and deadline_at <= loop.time():
            raise RequestTimeoutError(full_subject, timeout_ms)

        future: asyncio.Future[JSONValue] = loop.create_future()
        message: dict[str, Any] = {
            "type": "request",
            "namespace": ns,
            "subject": subject_name,
            "payload": wire_payload,
            "correlationId": correlation_id,
            "messageId": self._new_id(),
        }
        if timeout is not None:
            message["timeout"] = timeout
        if remote_priority is not None:
            message["priority"] = remote_priority
        if deadline is not None:
            message["deadline"] = deadline

        effective_timeout: float | None = None if deadline_at is None else max(0.0, deadline_at - loop.time())

        try:
            async with self._connection_lock:
                self._pending[correlation_id] = future
                try:
                    await self._send(message)
                except Exception:
                    self._pending.pop(correlation_id, None)
                    raise
            if effective_timeout is None:
                result = await future
            else:
                try:
                    result = await asyncio.wait_for(future, timeout=effective_timeout)
                except asyncio.TimeoutError:
                    raise RequestTimeoutError(full_subject, timeout_ms)
            response_type = self._response_types.get(full_subject)
            if response_type is not None and isinstance(result, dict):
                return from_wire(result, response_type)
            return result
        finally:
            self._pending.pop(correlation_id, None)

    async def once(
        self,
        subject: SubjectLike | str,
        filter: dict[str, Any] | None = None,
        *,
        timeout_ms: float | None = None,
    ) -> EventContext[Any]:
        """Subscribe temporarily and resolve on the first matching event.

        @param subject: Event subject to listen for.
        @param filter: Optional dict of key/value pairs that must all match in
            the event payload. Non-matching events are skipped.
        @param timeout_ms: Timeout in milliseconds. Raises
            :class:`~makaio.types.OnceTimeoutError` if exceeded.
        @returns: The :class:`~makaio.types.EventContext` of the first matching
            event.
        @raises OnceTimeoutError: If ``timeout_ms`` elapses before a match.
        """
        full_subject = _resolve_subject(subject)
        loop = asyncio.get_running_loop()
        resolved: asyncio.Future[EventContext[Any]] = loop.create_future()
        filter_dict = filter

        async def _once_handler(ctx: EventContext[Any]) -> None:
            if resolved.done():
                return
            if filter_dict:
                filter_payload = (
                    ctx.payload if isinstance(ctx.payload, Mapping) else to_wire(ctx.payload)
                )
                for key, expected in filter_dict.items():
                    if (
                        not isinstance(filter_payload, Mapping)
                        or filter_payload.get(key) != expected
                    ):
                        return
            resolved.set_result(ctx)

        sub = await self.subscribe(subject, _once_handler)
        try:
            if timeout_ms is not None:
                timeout_s = timeout_ms / 1000.0
                try:
                    return await asyncio.wait_for(
                        asyncio.shield(resolved), timeout=timeout_s
                    )
                except asyncio.TimeoutError:
                    raise OnceTimeoutError(full_subject, timeout_ms)
            return await resolved
        finally:
            await sub.close()

    # ------------------------------------------------------------------
    # Internal — connection lifecycle
    # ------------------------------------------------------------------

    async def _open_connection(self) -> None:
        transport = self._create_transport()

        try:
            # Auth probe
            secret: str | None = None
            if self._auth_mode is not False:
                health = await probe_health(self.url)
                auth_required = (
                    health.auth
                    if health is not None
                    else self._auth_mode is True
                )
                if auth_required:
                    raw_secret = os.environ.get("MAKAIO_BUS_SECRET")
                    secret = normalize_bus_secret(raw_secret)
                    if secret is None:
                        raise RuntimeError(
                            "MAKAIO_BUS_SECRET is required but not set"
                        )

            await transport.connect()

            if secret is not None:
                async def _recv_first() -> dict[str, Any]:
                    async for msg in transport.messages():
                        return msg
                    raise RuntimeError("Transport closed before auth challenge")

                await run_auth_handshake(transport.send, _recv_first, secret)

            self._closed = False
            self._transport = transport
            self._readiness_future = asyncio.get_running_loop().create_future()
            await self._send_subscribe_snapshot()

            self._reader_task = asyncio.create_task(self._read_loop())
            await self._readiness_future
            self._readiness_future = None
        except BaseException:
            self._readiness_future = None
            if self._transport is transport:
                with contextlib.suppress(Exception):
                    await self._reset_connection("Makaio bus connection closed")
            else:
                with contextlib.suppress(Exception):
                    await transport.close()
            raise

    async def _open_connection_with_timeout(self) -> None:
        timeout_s = self._connect_timeout_ms / 1000.0
        await asyncio.wait_for(self._open_connection(), timeout=timeout_s)

    def _create_transport(self) -> Transport:
        """Create the transport for a new connection.

        @returns: A fresh transport instance.
        """
        if self._transport_factory is not None:
            return self._transport_factory()
        return WebSocketTransport(self.url, websocket_factory=self._websocket_factory)

    def _new_id(self) -> str:
        """Generate a unique message identifier.

        @returns: A unique string identifier.
        """
        return self._id_factory()

    async def _send(self, message: dict[str, Any]) -> None:
        """Serialise and transmit *message* over the active transport.

        @param message: The message dict to send.
        @raises RuntimeError: If no transport is connected.
        """
        transport = self._transport
        if transport is None:
            raise RuntimeError("BusClient is not connected")
        await transport.send(message)

    # ------------------------------------------------------------------
    # Internal — read loop
    # ------------------------------------------------------------------

    async def _read_loop(self) -> None:
        transport = self._transport
        if transport is None:
            return

        try:
            async for message in transport.messages():
                try:
                    await self._handle_raw_message(message)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    LOGGER.exception(
                        "Makaio bus connection received an invalid frame"
                    )
                    await self._mark_connection_closed(
                        "Makaio bus connection received an invalid frame",
                        transport=transport,
                    )
                    return
            await self._mark_connection_closed(
                "Makaio bus connection closed", transport=transport
            )
        except asyncio.CancelledError:
            raise
        except json.JSONDecodeError:
            # A malformed JSON frame from the server counts as an invalid frame,
            # not merely a connection drop — log at ERROR so callers can detect it.
            LOGGER.exception("Makaio bus connection received an invalid frame")
            await self._mark_connection_closed(
                "Makaio bus connection received an invalid frame",
                transport=transport,
            )
        except Exception:
            LOGGER.debug("WebSocket recv failed, closing connection", exc_info=True)
            await self._mark_connection_closed(
                "Makaio bus connection closed", transport=transport
            )

    async def _handle_raw_message(self, message: dict[str, Any]) -> None:
        """Dispatch a decoded inbound message to the appropriate handler.

        @param message: Parsed JSON dict from the transport.
        """
        message_type = message.get("type")
        if message_type == "heartbeat" or message_type == "subscribe-sync-complete":
            if message_type == "subscribe-sync-complete":
                readiness_future = self._readiness_future
                if readiness_future is not None and not readiness_future.done():
                    readiness_future.set_result(None)
            return
        if message_type == "event":
            self._dispatch_event_to_handlers(message)
            return
        if message_type == "request":
            self._run_background_task(
                self._handle_request(message), description="request frame"
            )
            return
        if message_type == "response":
            self._handle_response(message)
            return
        if message_type == "broadcast" or message_type == "broadcast-response":
            return

    def _dispatch_event_to_handlers(self, message: dict[str, Any]) -> None:
        """Schedule each matching event handler as its own tracked background task.

        Each handler is registered individually in ``_background_tasks`` so that
        :meth:`_cancel_background_tasks` can safely exclude the *current* task
        even when a handler calls :meth:`close` from within its own body. Using a
        single outer background task with ``asyncio.gather`` sub-tasks would cause
        the ``current_task()`` exclusion check to fail because gather creates
        separate sub-tasks that are not in ``_background_tasks``.

        @param message: The inbound event message dict.
        """
        full_subject = _full_subject_from_message(message)
        if full_subject is None:
            return

        ctx = EventContext(
            payload=self._payload_from_wire(
                full_subject,
                message.get("payload"),
                self._event_payload_types,
            ),
            subject=full_subject,
            message_id=message.get("messageId", ""),
            correlation_id=message.get("correlationId"),
            message=message,
        )

        # Collect all matching handlers sorted by priority (desc), mirroring
        # dispatch_event semantics without creating gather sub-tasks.
        entries = self._bus.collect_matching_event_entries(full_subject)
        for entry in entries:
            self._run_background_task(
                invoke_event_handler(entry.handler, ctx),
                description=f"event handler for {full_subject}",
            )

    async def _handle_request(self, message: dict[str, Any]) -> None:
        correlation_id = message.get("correlationId")
        if not isinstance(correlation_id, str):
            return

        full_subject = _full_subject_from_message(message)
        if full_subject is None:
            return

        cursor = _priority_cursor(message)
        try:
            payload = self._payload_from_wire(
                full_subject,
                message.get("payload"),
                self._request_types,
            )
            result, has_result = await self._bus.dispatch_request(
                full_subject,
                payload,
                message_id=message.get("messageId", ""),
                correlation_id=correlation_id,
                message=message,
                cursor=cursor,
            )
        except BusError as error:
            await self._send(
                {
                    "type": "response",
                    "correlationId": correlation_id,
                    "error": error.to_payload(),
                }
            )
            return
        except Exception as error:
            await self._send_handler_error_response(correlation_id, full_subject, error)
            return

        if not has_result:
            await self._send_no_handler_response(correlation_id, full_subject)
            return

        try:
            await self._send(
                {
                    "type": "response",
                    "correlationId": correlation_id,
                    "result": to_wire(result),
                }
            )
        except Exception as error:
            await self._send_handler_error_response(
                correlation_id, full_subject, error
            )

    # ------------------------------------------------------------------
    # Internal — background task management
    # ------------------------------------------------------------------

    def _run_background_task(
        self, operation: Awaitable[None], *, description: str
    ) -> None:
        """Schedule *operation* as a background task.

        @param operation: The coroutine to run.
        @param description: Human-readable label for logging.
        """
        task = asyncio.create_task(operation)
        self._background_tasks.add(task)
        task.add_done_callback(
            lambda completed: self._finalize_background_task(
                completed, description=description
            )
        )

    def _finalize_background_task(
        self, task: asyncio.Task[None], *, description: str
    ) -> None:
        self._background_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            LOGGER.exception("Makaio bus %s failed", description)

    async def _cancel_background_tasks(self) -> None:
        current_task = asyncio.current_task()
        tasks = tuple(
            task for task in self._background_tasks if task is not current_task
        )
        if not tasks:
            return
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------------
    # Internal — connection reset and error propagation
    # ------------------------------------------------------------------

    async def _reset_connection(self, message: str) -> None:
        readiness_future = self._readiness_future
        self._readiness_future = None
        if readiness_future is not None and not readiness_future.done():
            readiness_future.set_exception(BusError(message, code="CONNECTION_CLOSED"))

        reader_task = self._reader_task
        self._reader_task = None
        if reader_task is not None and reader_task is not asyncio.current_task():
            reader_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass

        transport = self._transport
        self._transport = None
        try:
            await self._cancel_background_tasks()
        finally:
            try:
                if transport is not None:
                    await transport.close()
            finally:
                self._fail_pending(BusError(message, code="CONNECTION_CLOSED"))

    def _handle_response(self, message: dict[str, Any]) -> None:
        correlation_id = message.get("correlationId")
        if not isinstance(correlation_id, str):
            return

        future = self._pending.pop(correlation_id, None)
        if future is None or future.done():
            return

        error = message.get("error")
        if isinstance(error, Mapping):
            future.set_exception(BusError.from_payload(error))
            return

        future.set_result(message.get("result"))

    async def _send_no_handler_response(
        self, correlation_id: str, full_subject: str
    ) -> None:
        error = BusError(
            f'No handler registered for request subject "{full_subject}"',
            code="NO_HANDLER",
            subject=full_subject,
        )
        await self._send(
            {"type": "response", "correlationId": correlation_id, "error": error.to_payload()}
        )

    async def _send_handler_error_response(
        self, correlation_id: str, full_subject: str, error: BaseException
    ) -> None:
        bus_error = BusError(str(error), code="HANDLER_ERROR", subject=full_subject)
        await self._send(
            {"type": "response", "correlationId": correlation_id, "error": bus_error.to_payload()}
        )

    async def _send_subscribe_snapshot(self) -> None:
        if self._transport is None:
            return

        # Build snapshot: all event patterns with [] priorities, all request
        # subjects with their advertised priorities. Request entries win when
        # the same subject appears in both (e.g. a handler registered as both
        # event and request listener).
        event_patterns = {pattern: [] for pattern in self._bus.event_patterns()}
        request_priorities: dict[str, list[int]] = self._bus.subscription_snapshot()

        payload: dict[str, list[int]] = {**event_patterns, **request_priorities}
        if not payload:
            return

        await self._send({"type": "subscribe", "subjects": payload})

    async def _send_unsubscribe(
        self, full_subject: str, priorities: list[int]
    ) -> None:
        if self._transport is not None:
            await self._send(
                {"type": "unsubscribe", "subjects": {full_subject: priorities}}
            )

    async def _remove_subscription(
        self, full_subject: str, registration: Registration, *, request: bool
    ) -> None:
        async with self._connection_lock:
            # Snapshot the advertised priorities *before* removing so we can
            # send the correct unsubscribe frame if this was the last handler.
            last_priorities = self._bus.priorities_for(full_subject) if request else []
            removed = self._bus.remove(registration)
            if not removed:
                return

            if not self._bus.has_any_handler(full_subject):
                await self._send_unsubscribe(full_subject, last_priorities)
                return

            await self._send_subscribe_snapshot()

    async def _mark_connection_closed(
        self, message: str, *, transport: Transport | None = None
    ) -> None:
        """Mark the transport closed and fail unresolved request futures.

        @param message: Human-readable reason for the closure.
        @param transport: The specific transport instance to check against; if
            the active transport has already been replaced this call is a
            no-op.
        """
        async with self._connection_lock:
            if transport is not None and self._transport is not transport:
                return
            await self._reset_connection(message)
            if self._auto_reconnect and not self._closed:
                self._run_background_task(
                    self._auto_reconnect_once(),
                    description="auto reconnect",
                )

    async def _auto_reconnect_once(self) -> None:
        """Reconnect once after an unexpected transport closure."""
        async with self._connection_lock:
            if self._closed or self._transport is not None:
                return
            await self._open_connection_with_timeout()

    def _fail_pending(self, error: BaseException) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    def _remember_subject_types(self, subject: SubjectLike | str) -> None:
        full_subject = _resolve_subject(subject)
        if isinstance(subject, EventSubject) and subject._payload_type is not None:
            self._event_payload_types[full_subject] = subject._payload_type
        if isinstance(subject, RequestSubject):
            if subject._request_type is not None:
                self._request_types[full_subject] = subject._request_type
            if subject._response_type is not None:
                self._response_types[full_subject] = subject._response_type

    def _payload_from_wire(
        self,
        full_subject: str,
        payload: JSONValue,
        type_map: Mapping[str, type[Any]],
    ) -> JSONValue:
        payload_type = type_map.get(full_subject)
        if payload_type is not None and isinstance(payload, dict):
            return from_wire(payload, payload_type)
        return payload


# ---------------------------------------------------------------------------
# Subject resolution helpers
# ---------------------------------------------------------------------------


def _resolve_subject(subject: SubjectLike | str) -> str:
    """Extract the full subject string from any subject descriptor or plain string.

    @param subject: An :class:`~makaio.types.EventSubject`,
        :class:`~makaio.types.RequestSubject`,
        :class:`~makaio.types.WildcardSubject`, or plain ``str``.
    @returns: The full subject or pattern string.
    """
    if isinstance(subject, (EventSubject, RequestSubject)):
        return subject.full_subject
    if isinstance(subject, WildcardSubject):
        return subject.pattern
    return subject  # plain str


# ---------------------------------------------------------------------------
# Subject validation helpers
# ---------------------------------------------------------------------------


def _ensure_exact_subject(
    subject: str, *, namespace: str | None = None
) -> None:
    """Raise :exc:`ValueError` if *subject* contains wildcards.

    @param subject: Subject string to validate.
    @param namespace: Optional namespace; wildcards here are also rejected.
    @raises ValueError: If any wildcard character is found.
    """
    if _has_wildcard(subject) or (
        namespace is not None and _has_wildcard(namespace)
    ):
        raise ValueError("subjects must be exact and cannot contain wildcards")


def _ensure_supported_subscription_pattern(pattern: str) -> None:
    """Raise :exc:`ValueError` if *pattern* is not a supported wildcard form.

    Supported forms: exact, ``'*'``, ``'<prefix>.*'``, ``'<prefix>:*'``.

    @param pattern: The subscription pattern to validate.
    @raises ValueError: If the pattern contains an unsupported wildcard shape.
    """
    if pattern == "*" or not _has_wildcard(pattern):
        return
    if pattern.endswith(".*") and pattern.count("*") == 1:
        return
    if pattern.endswith(":*") and pattern.count("*") == 1:
        return
    raise ValueError(
        "subscription patterns must be exact subjects, '*', or end with '.*' or ':*'"
    )


def _has_wildcard(subject: str) -> bool:
    return "*" in subject


# ---------------------------------------------------------------------------
# Wire format helpers
# ---------------------------------------------------------------------------


def _split_subject(subject: str, *, namespace: str | None) -> tuple[str, str]:
    """Split a full subject into ``(namespace, subject_name)`` pair.

    @param subject: Full subject string (e.g. ``'agent.started'``), or a bare
        subject name when *namespace* is provided explicitly.
    @param namespace: When not ``None``, *subject* is treated as the bare
        subject name and *namespace* is used as-is.
    @returns: ``(namespace, subject_name)`` tuple.
    @raises ValueError: If *subject* cannot be split without an explicit
        namespace.
    """
    if namespace is not None:
        return namespace, subject

    namespace_part, separator, subject_part = subject.partition(".")
    if not separator or not namespace_part or not subject_part:
        raise ValueError(
            "subject must be a full subject like 'agent.started' "
            "when namespace is omitted"
        )
    return namespace_part, subject_part


def _full_subject_from_message(message: dict[str, Any]) -> str | None:
    namespace = message.get("namespace")
    subject = message.get("subject")
    if not isinstance(namespace, str) or not isinstance(subject, str):
        return None
    return f"{namespace}.{subject}"


def _priority_cursor(message: dict[str, Any]) -> float | int | None:
    priority = message.get("priority")
    if isinstance(priority, (int, float)):
        return priority
    return None

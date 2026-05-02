"""Async Makaio bus protocol client."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, Union

JSONValue = Any
Message = dict[str, Any]
EventHandler = Callable[[JSONValue, Mapping[str, Any]], Union[Awaitable[None], None]]
RequestHandler = Callable[[JSONValue, Mapping[str, Any]], Union[Awaitable[JSONValue], JSONValue]]
LOGGER = logging.getLogger(__name__)


class WebSocketLike(Protocol):
    """Minimal async websocket surface used by BusClient."""

    async def send(self, message: str) -> None:
        """Send a text frame."""

    async def recv(self) -> str | bytes:
        """Receive the next text or binary frame."""

    async def close(self) -> None:
        """Close the websocket."""


WebSocketFactory = Callable[[str], Union[Awaitable[WebSocketLike], WebSocketLike]]
IdFactory = Callable[[], str]


class BusError(RuntimeError):
    """Structured error returned by a remote Makaio bus participant."""

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
        """Create a bus error from a response error payload."""

        message = payload.get("message")
        if not isinstance(message, str):
            message = "Makaio bus request failed"

        data = payload.get("data")
        return cls(
            message,
            code=payload.get("code") if isinstance(payload.get("code"), str) else None,
            subject=payload.get("subject") if isinstance(payload.get("subject"), str) else None,
            data=data if isinstance(data, Mapping) else None,
        )

    def to_payload(self) -> dict[str, Any]:
        """Serialize this error into the Makaio bus error envelope."""

        payload: dict[str, Any] = {"message": self.message}
        if self.code is not None:
            payload["code"] = self.code
        if self.subject is not None:
            payload["subject"] = self.subject
        if self.data:
            payload["data"] = self.data
        return payload


@dataclass
class _EventRegistration:
    handler: EventHandler


@dataclass
class _RequestRegistration:
    handler: RequestHandler
    priority: int


@dataclass
class _SubjectState:
    event_handlers: list[_EventRegistration] = field(default_factory=list)
    request_handlers: list[_RequestRegistration] = field(default_factory=list)

    def priorities(self) -> list[int]:
        """Return the full request priority set for this subject."""

        return sorted({handler.priority for handler in self.request_handlers}, reverse=True)

    def ordered_request_handlers(self, cursor: float | int | None) -> list[_RequestRegistration]:
        """Return request handlers in Makaio priority order."""

        handlers = sorted(self.request_handlers, key=lambda registration: registration.priority, reverse=True)
        if cursor is None:
            return handlers
        return [registration for registration in handlers if registration.priority < cursor]

    def is_empty(self) -> bool:
        """Return whether this subject has no local handlers."""

        return not self.event_handlers and not self.request_handlers


def _advertised_priorities(state: _SubjectState | None, *, request: bool) -> list[int]:
    """Return the priority snapshot that should be preserved in wire updates."""

    if not request or state is None:
        return []
    return state.priorities()


class Subscription:
    """Handle returned by subscribe and on_request."""

    def __init__(self, client: "BusClient", full_subject: str, handler: object, *, request: bool) -> None:
        self._client = client
        self._full_subject = full_subject
        self._handler = handler
        self._request = request
        self._closed = False

    async def close(self) -> None:
        """Remove this local handler and update remote subscription state."""

        if self._closed:
            return

        self._closed = True
        await self._client._remove_subscription(
            self._full_subject,
            self._handler,
            request=self._request,
        )


class BusClient:
    """Small async client for the Makaio WebSocket bus protocol."""

    def __init__(
        self,
        url: str,
        *,
        websocket_factory: WebSocketFactory | None = None,
        id_factory: IdFactory | None = None,
    ) -> None:
        self.url = url
        self._connection_lock = asyncio.Lock()
        self._websocket_factory = websocket_factory
        self._id_factory = id_factory or (lambda: uuid.uuid4().hex)
        self._websocket: WebSocketLike | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._pending: dict[str, asyncio.Future[JSONValue]] = {}
        self._subjects: dict[str, _SubjectState] = {}
        self._closed = False

    async def connect(self) -> None:
        """Open the websocket connection and replay local subscriptions."""

        async with self._connection_lock:
            if self._websocket is not None:
                return
            await self._open_connection()

    async def reconnect(self) -> None:
        """Reopen the websocket connection and replay local subscriptions."""

        async with self._connection_lock:
            await self._reset_connection("Makaio bus connection closed")
            await self._open_connection()

    async def close(self) -> None:
        """Close the websocket connection and fail pending requests."""

        async with self._connection_lock:
            self._closed = True
            await self._reset_connection("Makaio bus connection closed")

    async def emit(
        self,
        subject: str,
        payload: JSONValue,
        *,
        namespace: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Emit an event payload to the bus."""

        _ensure_exact_subject(subject, namespace=namespace)
        namespace, subject_name = _split_subject(subject, namespace=namespace)
        message: Message = {
            "type": "event",
            "namespace": namespace,
            "subject": subject_name,
            "payload": payload,
            "messageId": self._new_id(),
        }
        if correlation_id is not None:
            message["correlationId"] = correlation_id

        await self._send(message)

    async def request(
        self,
        subject: str,
        payload: JSONValue,
        *,
        namespace: str | None = None,
        timeout: float | int | None = None,
        priority: int | None = None,
        deadline: float | int | None = None,
        response_timeout: float | None = None,
    ) -> JSONValue:
        """Send a request and wait for one response with the matching correlationId."""

        _ensure_exact_subject(subject, namespace=namespace)
        namespace, subject_name = _split_subject(subject, namespace=namespace)
        correlation_id = self._new_id()
        future = asyncio.get_running_loop().create_future()

        message: Message = {
            "type": "request",
            "namespace": namespace,
            "subject": subject_name,
            "payload": payload,
            "correlationId": correlation_id,
            "messageId": self._new_id(),
        }
        if timeout is not None:
            message["timeout"] = timeout
        if priority is not None:
            message["priority"] = priority
        if deadline is not None:
            message["deadline"] = deadline

        try:
            async with self._connection_lock:
                self._pending[correlation_id] = future
                try:
                    await self._send(message)
                except Exception:
                    self._pending.pop(correlation_id, None)
                    raise
            if response_timeout is None:
                return await future
            return await asyncio.wait_for(future, timeout=response_timeout)
        finally:
            self._pending.pop(correlation_id, None)

    async def subscribe(self, subject: str, handler: EventHandler, *, namespace: str | None = None) -> Subscription:
        """Register a local event handler and advertise an event subscription."""

        full_subject = _subscription_subject(subject, namespace=namespace)
        _ensure_supported_subscription_pattern(full_subject)
        async with self._connection_lock:
            state = self._subjects.setdefault(full_subject, _SubjectState())
            registration = _EventRegistration(handler=handler)
            state.event_handlers.append(registration)
            try:
                await self._send_subscribe_snapshot()
            except Exception:
                self._remove_local_subscription(full_subject, registration, request=False)
                raise
        return Subscription(self, full_subject, registration, request=False)

    async def on_request(
        self,
        subject: str,
        handler: RequestHandler,
        *,
        namespace: str | None = None,
        priority: int = 0,
    ) -> Subscription:
        """Register a local request handler and advertise its request priority."""

        _ensure_exact_subject(subject, namespace=namespace)
        full_subject = _full_subject(subject, namespace=namespace)
        async with self._connection_lock:
            state = self._subjects.setdefault(full_subject, _SubjectState())
            registration = _RequestRegistration(handler=handler, priority=priority)
            state.request_handlers.append(registration)
            try:
                await self._send_subscribe_snapshot()
            except Exception:
                self._remove_local_subscription(full_subject, registration, request=True)
                raise
        return Subscription(self, full_subject, registration, request=True)

    async def _connect_websocket(self) -> WebSocketLike:
        try:
            from websockets.asyncio.client import connect
        except ImportError:
            from websockets import connect  # type: ignore[no-redef]

        return await connect(self.url)

    async def _open_connection(self) -> None:
        websocket = self._websocket_factory(self.url) if self._websocket_factory else await self._connect_websocket()
        if inspect.isawaitable(websocket):
            websocket = await websocket

        self._closed = False
        self._websocket = websocket
        try:
            await self._send_subscribe_snapshot()
        except Exception:
            self._websocket = None
            self._closed = True
            with contextlib.suppress(Exception):
                await websocket.close()
            raise

        self._reader_task = asyncio.create_task(self._read_loop())

    def _new_id(self) -> str:
        return self._id_factory()

    async def _send(self, message: Mapping[str, Any]) -> None:
        websocket = self._websocket
        if websocket is None:
            raise RuntimeError("BusClient is not connected")

        await websocket.send(json.dumps(message, separators=(",", ":")))

    async def _read_loop(self) -> None:
        while not self._closed:
            websocket = self._websocket
            if websocket is None:
                return

            try:
                raw_message = await websocket.recv()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.debug("WebSocket recv failed, closing connection", exc_info=True)
                await self._mark_connection_closed("Makaio bus connection closed", websocket=websocket)
                return

            try:
                await self._handle_raw_message(raw_message)
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("Makaio bus connection received an invalid frame")
                await self._mark_connection_closed("Makaio bus connection received an invalid frame", websocket=websocket)
                return

    async def _handle_raw_message(self, raw_message: str | bytes) -> None:
        if isinstance(raw_message, bytes):
            raw_message = raw_message.decode("utf-8")

        decoded = json.loads(raw_message)
        if not isinstance(decoded, dict):
            return

        message_type = decoded.get("type")
        if message_type == "heartbeat" or message_type == "subscribe-sync-complete":
            return
        if message_type == "event":
            self._run_background_task(self._handle_event(decoded), description="event frame")
            return
        if message_type == "request":
            self._run_background_task(self._handle_request(decoded), description="request frame")
            return
        if message_type == "response":
            self._handle_response(decoded)
            return
        if message_type == "broadcast" or message_type == "broadcast-response":
            return

    async def _handle_event(self, message: Mapping[str, Any]) -> None:
        full_subject = _full_subject_from_message(message)
        if full_subject is None:
            return

        for state in self._matching_states(full_subject):
            for registration in tuple(state.event_handlers):
                try:
                    await _maybe_await(registration.handler(message.get("payload"), message))
                except Exception:
                    LOGGER.exception("Makaio event handler failed for %s", full_subject)

    async def _handle_request(self, message: Mapping[str, Any]) -> None:
        correlation_id = message.get("correlationId")
        if not isinstance(correlation_id, str):
            return

        full_subject = _full_subject_from_message(message)
        if full_subject is None:
            return

        registrations = [
            registration
            for state in self._matching_states(full_subject)
            for registration in state.ordered_request_handlers(_priority_cursor(message))
        ]
        registrations.sort(key=lambda registration: registration.priority, reverse=True)

        if not registrations:
            await self._send_no_handler_response(correlation_id, full_subject)
            return

        registration = registrations[0]
        try:
            result = await _maybe_await(registration.handler(message.get("payload"), message))
        except BusError as error:
            await self._send({"type": "response", "correlationId": correlation_id, "error": error.to_payload()})
            return
        except Exception as error:
            await self._send_handler_error_response(correlation_id, full_subject, error)
            return

        try:
            await self._send({"type": "response", "correlationId": correlation_id, "result": result})
        except Exception as error:
            await self._send_handler_error_response(correlation_id, full_subject, error)
            return

    def _run_background_task(self, operation: Awaitable[None], *, description: str) -> None:
        task = asyncio.create_task(operation)
        self._background_tasks.add(task)
        task.add_done_callback(lambda completed: self._finalize_background_task(completed, description=description))

    def _finalize_background_task(self, task: asyncio.Task[None], *, description: str) -> None:
        self._background_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception:
            LOGGER.exception("Makaio bus %s failed", description)

    async def _cancel_background_tasks(self) -> None:
        current_task = asyncio.current_task()
        tasks = tuple(task for task in self._background_tasks if task is not current_task)
        if not tasks:
            return

        for task in tasks:
            task.cancel()

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _reset_connection(self, message: str) -> None:
        reader_task = self._reader_task
        self._reader_task = None
        if reader_task is not None and reader_task is not asyncio.current_task():
            reader_task.cancel()
            try:
                await reader_task
            except asyncio.CancelledError:
                pass

        websocket = self._websocket
        self._websocket = None
        try:
            await self._cancel_background_tasks()
        finally:
            try:
                if websocket is not None:
                    await websocket.close()
            finally:
                self._fail_pending(BusError(message, code="CONNECTION_CLOSED"))

    def _handle_response(self, message: Mapping[str, Any]) -> None:
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

    async def _send_no_handler_response(self, correlation_id: str, full_subject: str) -> None:
        await self._send(
            {
                "type": "response",
                "correlationId": correlation_id,
                "error": {
                    "message": f'No handler registered for request subject "{full_subject}"',
                    "code": "NO_HANDLER",
                    "subject": full_subject,
                },
            },
        )

    async def _send_subscribe_snapshot(self) -> None:
        if self._websocket is None:
            return

        if not self._subjects:
            return

        payload = {
            full_subject: self._subjects[full_subject].priorities()
            for full_subject in sorted(self._subjects)
            if not self._subjects[full_subject].is_empty()
        }
        if payload:
            await self._send({"type": "subscribe", "subjects": payload})

    async def _send_unsubscribe(self, full_subject: str, priorities: list[int]) -> None:
        if self._websocket is not None:
            await self._send({"type": "unsubscribe", "subjects": {full_subject: priorities}})

    async def _send_handler_error_response(self, correlation_id: str, full_subject: str, error: BaseException) -> None:
        await self._send(
            {
                "type": "response",
                "correlationId": correlation_id,
                "error": {"message": str(error), "code": "HANDLER_ERROR", "subject": full_subject},
            },
        )

    async def _remove_subscription(self, full_subject: str, handler: object, *, request: bool) -> None:
        async with self._connection_lock:
            last_advertised_priorities = _advertised_priorities(self._subjects.get(full_subject), request=request)
            remaining = self._remove_local_subscription(full_subject, handler, request=request)
            if remaining is None:
                return

            if not remaining:
                await self._send_unsubscribe(full_subject, last_advertised_priorities)
                return

            await self._send_subscribe_snapshot()

    def _remove_local_subscription(self, full_subject: str, handler: object, *, request: bool) -> bool | None:
        state = self._subjects.get(full_subject)
        if state is None:
            return None

        if request:
            state.request_handlers = [registration for registration in state.request_handlers if registration is not handler]
        else:
            state.event_handlers = [registered for registered in state.event_handlers if registered is not handler]

        if state.is_empty():
            self._subjects.pop(full_subject, None)
            return False

        return True

    def _matching_states(self, full_subject: str) -> list[_SubjectState]:
        states: list[_SubjectState] = []
        exact_state = self._subjects.get(full_subject)
        if exact_state is not None:
            states.append(exact_state)

        for pattern, state in self._subjects.items():
            if pattern == full_subject:
                continue
            if _subject_matches_pattern(pattern, full_subject):
                states.append(state)

        return states

    def _fail_pending(self, error: BaseException) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    async def _mark_connection_closed(self, message: str, *, websocket: WebSocketLike) -> None:
        """Mark the active socket closed and fail unresolved request futures."""

        async with self._connection_lock:
            if self._websocket is not websocket:
                return
            await self._reset_connection(message)


async def _maybe_await(value: Awaitable[JSONValue] | JSONValue) -> JSONValue:
    if inspect.isawaitable(value):
        return await value
    return value


def _split_subject(subject: str, *, namespace: str | None) -> tuple[str, str]:
    if namespace is not None:
        return namespace, subject

    namespace_part, separator, subject_part = subject.partition(".")
    if not separator or not namespace_part or not subject_part:
        raise ValueError("subject must be a full subject like 'agent.started' when namespace is omitted")

    return namespace_part, subject_part


def _full_subject(subject: str, *, namespace: str | None) -> str:
    namespace_part, subject_part = _split_subject(subject, namespace=namespace)
    return f"{namespace_part}.{subject_part}"


def _subscription_subject(subject: str, *, namespace: str | None) -> str:
    if namespace is not None:
        return f"{namespace}.{subject}"
    if _has_wildcard(subject):
        return subject
    return _full_subject(subject, namespace=namespace)


def _ensure_exact_subject(subject: str, *, namespace: str | None) -> None:
    if _has_wildcard(subject) or (namespace is not None and _has_wildcard(namespace)):
        raise ValueError("subjects must be exact and cannot contain wildcards")


def _has_wildcard(subject: str) -> bool:
    return "*" in subject


def _ensure_supported_subscription_pattern(pattern: str) -> None:
    if pattern == "*" or not _has_wildcard(pattern):
        return
    if pattern.endswith(".*") and pattern.count("*") == 1:
        return
    if pattern.endswith(":*") and pattern.count("*") == 1:
        return
    raise ValueError("subscription patterns must be exact subjects, '*', or end with '.*' or ':*'")


def _subject_matches_pattern(pattern: str, full_subject: str) -> bool:
    if pattern == "*":
        return True
    if pattern.endswith(".*"):
        base = pattern[:-2]
        return full_subject.startswith(f"{base}.")
    if pattern.endswith(":*"):
        base = pattern[:-2]
        return full_subject.startswith(f"{base}:")
    return pattern == full_subject


def _full_subject_from_message(message: Mapping[str, Any]) -> str | None:
    namespace = message.get("namespace")
    subject = message.get("subject")
    if not isinstance(namespace, str) or not isinstance(subject, str):
        return None
    return f"{namespace}.{subject}"


def _priority_cursor(message: Mapping[str, Any]) -> float | int | None:
    priority = message.get("priority")
    if isinstance(priority, (int, float)):
        return priority
    return None

"""Public type contracts for the Makaio SDK."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar, Union

T = TypeVar("T")
Req = TypeVar("Req")
Res = TypeVar("Res")

JSONValue = Any


class EventSubject(Generic[T]):
    """Typed event subject descriptor. Carries payload type for IDE inference."""

    __slots__ = ("full_subject", "_payload_type")

    def __init__(self, full_subject: str, *, payload_type: type[T] | None = None) -> None:
        self.full_subject = full_subject
        self._payload_type = payload_type

    def __repr__(self) -> str:
        return f"EventSubject({self.full_subject!r})"


class RequestSubject(Generic[Req, Res]):
    """Typed request subject descriptor. Carries request and response types."""

    __slots__ = ("full_subject", "_request_type", "_response_type")

    def __init__(
        self,
        full_subject: str,
        *,
        request_type: type[Req] | None = None,
        response_type: type[Res] | None = None,
    ) -> None:
        self.full_subject = full_subject
        self._request_type = request_type
        self._response_type = response_type

    def __repr__(self) -> str:
        return f"RequestSubject({self.full_subject!r})"


class WildcardSubject(Generic[T]):
    """Typed wildcard subject descriptor for pattern subscriptions (e.g. 'agent.*')."""

    __slots__ = ("pattern",)

    def __init__(self, pattern: str) -> None:
        self.pattern = pattern

    def __repr__(self) -> str:
        return f"WildcardSubject({self.pattern!r})"


SubjectLike = EventSubject[Any] | RequestSubject[Any, Any] | WildcardSubject[Any] | str


@dataclass(frozen=True)
class EventContext(Generic[T]):
    """Context passed to event handlers."""

    payload: T
    subject: str
    message_id: str
    correlation_id: str | None
    message: Mapping[str, Any]


class RequestContext(Generic[Req, Res]):
    """Mutable context for request handler middleware chain."""

    __slots__ = ("_payload", "subject", "message_id", "correlation_id", "message", "_result", "_has_result", "_next_fn")

    def __init__(
        self,
        *,
        payload: Req,
        subject: str,
        message_id: str,
        correlation_id: str,
        message: Mapping[str, Any],
    ) -> None:
        self._payload = payload
        self.subject = subject
        self.message_id = message_id
        self.correlation_id = correlation_id
        self.message = message
        self._result: Res | None = None
        self._has_result = False
        self._next_fn: Callable[[], Awaitable[None]] | None = None

    @property
    def payload(self) -> Req:
        """The current request payload."""
        return self._payload

    @property
    def has_result(self) -> bool:
        """Whether a result has been set by any handler in the chain."""
        return self._has_result

    @property
    def result(self) -> Res | None:
        """The current response value, or ``None`` if not yet set."""
        return self._result if self._has_result else None

    def set_result(self, value: Res) -> None:
        """Set the response value.

        @param value: The result to store as the handler response.
        """
        self._result = value
        self._has_result = True

    def extend_result(self, extension: Mapping[str, Any]) -> None:
        """Shallow-merge fields into the current result.

        @param extension: Key-value pairs to merge into the existing result dict.
        """
        base = dict(self._result) if self._has_result and isinstance(self._result, Mapping) else {}
        self._result = {**base, **extension}  # type: ignore[assignment]
        self._has_result = True

    def replace_payload(self, new_payload: Req) -> None:
        """Replace the payload for subsequent handlers in the chain.

        @param new_payload: The replacement payload value.
        """
        self._payload = new_payload

    async def next(self) -> None:
        """Delegate to the next handler in the middleware chain."""
        if self._next_fn is not None:
            fn = self._next_fn
            self._next_fn = None
            await fn()


@dataclass(frozen=True)
class ServerHealth:
    """Result of a bus server health probe."""

    auth: bool


class OnceTimeoutError(TimeoutError):
    """Raised when once() exceeds the specified timeout."""

    def __init__(self, subject: str, timeout_ms: float) -> None:
        super().__init__(f"once() timed out after {timeout_ms}ms waiting for {subject}")
        self.subject = subject
        self.timeout_ms = timeout_ms


class RequestTimeoutError(TimeoutError):
    """Raised when request() exceeds the specified local wait timeout."""

    def __init__(self, subject: str, timeout_ms: float) -> None:
        super().__init__(f"request() timed out after {timeout_ms}ms waiting for {subject}")
        self.subject = subject
        self.timeout_ms = timeout_ms


class WebSocketLike(Protocol):
    """Minimal async websocket surface used by the SDK."""

    async def send(self, message: str) -> None: ...
    async def recv(self) -> str | bytes: ...
    async def close(self) -> None: ...


WebSocketFactory = Callable[[str], Union[Awaitable[WebSocketLike], WebSocketLike]]
IdFactory = Callable[[], str]

EventHandlerFn = Callable[[EventContext[Any]], Union[Awaitable[None], None]]
RequestHandlerFn = Callable[[RequestContext[Any, Any]], Union[Awaitable[None], None]]

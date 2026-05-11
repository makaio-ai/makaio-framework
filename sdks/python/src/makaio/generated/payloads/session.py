"""Session payload types — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

@dataclass(frozen=True)
class SessionAgentAddedPayload:
    adapter_id: str
    adapter_name: str
    adapter_session_id: str
    agent_id: str
    session_id: str
    cwd: str | None = None
    model: str | None = None
    role: Literal["lead", "member"] | None = None


@dataclass(frozen=True)
class SessionCreatedPayload:
    branch_kind: Literal["fork", "branch", "subagent", "compress", "rewrite", "coordinator", "aside"] | None
    created_at: float
    parent_session_id: str | None
    session_id: str
    origin_window_id: str | None = None


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContextMessageHistoryItem:
    blocks: dict[str, Any]
    role: Literal["user", "assistant", "system"] | None = None


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContext:
    extracted_context: Any | None = None
    has_compression: bool | None = None
    has_connector_swap: bool | None = None
    has_new_transforms: bool | None = None
    is_first_turn: bool | None = None
    message_history: list[SessionSendMessageRequestSessionContextMessageHistoryItem] | None = None
    turn_context: dict[str, Any] | None = None


@dataclass(frozen=True)
class SessionSendMessageRequest:
    message: dict[str, Any]
    session_id: str
    agent: dict[str, Any] | None = None
    agent_ids: dict[str, Any] | None = None
    delivery_mode: Literal["enqueue"] | None = None
    extension_id: str | None = None
    origin: Literal["voice", "text", "compact"] | None = None
    origin_window_id: str | None = None
    session_context: SessionSendMessageRequestSessionContext | None = None
    skip_connector_swap_warning: bool | None = None
    source: Literal["extension", "user", "system"] | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class SessionSendMessageResponse:
    message_id: str
    session_id: str
    turn_id: str


@dataclass(frozen=True)
class SessionTurnCompletedPayloadInitiator:
    source: Literal["user", "extension", "system"]
    source_id: str | None = None


@dataclass(frozen=True)
class SessionTurnCompletedPayload:
    session_id: str
    success: bool
    turn_id: str
    turn_number: int
    error: str | None = None
    initiator: SessionTurnCompletedPayloadInitiator | None = None


@dataclass(frozen=True)
class SessionTurnStartedPayloadInitiator:
    source: Literal["user", "extension", "system"]
    source_id: str | None = None


@dataclass(frozen=True)
class SessionTurnStartedPayload:
    agent_ids: list[str]
    message_id: str
    session_id: str
    turn_id: str
    turn_number: int
    initiator: SessionTurnStartedPayloadInitiator | None = None


@dataclass(frozen=True)
class SessionUserMessageSentPayload:
    agent_ids: list[str]
    content: dict[str, Any]
    message_id: str
    session_id: str
    turn_id: str
    turn_number: int
    origin: Literal["voice", "text", "compact"] | None = None
    source: Literal["extension", "user", "system"] | None = None

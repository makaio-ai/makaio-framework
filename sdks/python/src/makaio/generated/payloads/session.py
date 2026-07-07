"""Session payload types — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Union

@dataclass(frozen=True)
class SessionAgentAddedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    session_id: str
    adapter_session_id: str | None = None
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
class SessionRestartAgentsRequest:
    session_id: str
    machine_id: str | None = None


@dataclass(frozen=True)
class SessionRestartAgentsResponseResultsItemVariantA:
    adapter_id: str
    agent_id: str
    success: Literal[True]


@dataclass(frozen=True)
class SessionRestartAgentsResponseResultsItemVariantB:
    adapter_id: str
    agent_id: str
    error: str
    success: Literal[False]


@dataclass(frozen=True)
class SessionRestartAgentsResponse:
    results: list[Union[SessionRestartAgentsResponseResultsItemVariantA, SessionRestartAgentsResponseResultsItemVariantB]]
    session_id: str


@dataclass(frozen=True)
class SessionSendMessageRequestResponseSchema:
    schema: dict[str, Any]
    name: str | None = None
    strict: bool | None = None


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContextMessageHistoryItem:
    blocks: dict[str, Any]
    role: Literal["user", "assistant", "system"] | None = None


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContextNativeFork:
    source_adapter_session_id: str
    source_session_id: str
    fork_point_message_id: str | None = None
    target_working_directory: str | None = None


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContextNativeLocalityVariantA:
    kind: Literal["native"]


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContextNativeLocalityVariantB:
    kind: Literal["degrade"]
    reason: Literal["adapter-unsupported", "adapter-mismatch", "no-adapter-session", "missing-machine-id", "machine-mismatch", "cwd-mismatch", "transforms-present", "compression-present", "connector-swap", "mid-history-unsupported", "hybrid-imported-orchestrated", "native-attempt-failed", "agent-already-started", "fork-point-unresolvable"]


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContextNativeLocalityVariantC:
    kind: Literal["foreign"]
    machine_id: str


@dataclass(frozen=True)
class SessionSendMessageRequestSessionContext:
    cache_strategy: Literal["auto", "systemPrompt", "fullPrefix"] | None = None
    extracted_context: Any | None = None
    has_compression: bool | None = None
    has_connector_swap: bool | None = None
    has_new_transforms: bool | None = None
    is_first_turn: bool | None = None
    message_history: list[SessionSendMessageRequestSessionContextMessageHistoryItem] | None = None
    native_fork: SessionSendMessageRequestSessionContextNativeFork | None = None
    native_locality: Union[SessionSendMessageRequestSessionContextNativeLocalityVariantA, SessionSendMessageRequestSessionContextNativeLocalityVariantB, SessionSendMessageRequestSessionContextNativeLocalityVariantC] | None = None
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
    response_schema: SessionSendMessageRequestResponseSchema | None = None
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
class SessionTurnAwaitRequest:
    session_id: str
    timeout_ms: int
    turn_id: str


@dataclass(frozen=True)
class SessionTurnAwaitResponseCompletionInitiator:
    source: Literal["user", "extension", "system"]
    source_id: str | None = None


@dataclass(frozen=True)
class SessionTurnAwaitResponseCompletionUsageTotal:
    input_tokens: float
    output_tokens: float
    cost: float | None = None


@dataclass(frozen=True)
class SessionTurnAwaitResponseCompletionUsage:
    total: SessionTurnAwaitResponseCompletionUsageTotal
    by_agent: dict[str, Any] | None = None


@dataclass(frozen=True)
class SessionTurnAwaitResponseCompletion:
    session_id: str
    success: bool
    turn_id: str
    turn_number: int
    error: str | None = None
    ingestion_marker: Literal["live", "backfill"] | None = None
    initiator: SessionTurnAwaitResponseCompletionInitiator | None = None
    usage: SessionTurnAwaitResponseCompletionUsage | None = None


@dataclass(frozen=True)
class SessionTurnAwaitResponse:
    completion: SessionTurnAwaitResponseCompletion


@dataclass(frozen=True)
class SessionTurnCompletedPayloadInitiator:
    source: Literal["user", "extension", "system"]
    source_id: str | None = None


@dataclass(frozen=True)
class SessionTurnCompletedPayloadUsageTotal:
    input_tokens: float
    output_tokens: float
    cost: float | None = None


@dataclass(frozen=True)
class SessionTurnCompletedPayloadUsage:
    total: SessionTurnCompletedPayloadUsageTotal
    by_agent: dict[str, Any] | None = None


@dataclass(frozen=True)
class SessionTurnCompletedPayload:
    session_id: str
    success: bool
    turn_id: str
    turn_number: int
    error: str | None = None
    ingestion_marker: Literal["live", "backfill"] | None = None
    initiator: SessionTurnCompletedPayloadInitiator | None = None
    usage: SessionTurnCompletedPayloadUsage | None = None


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
    ingestion_marker: Literal["live", "backfill"] | None = None
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

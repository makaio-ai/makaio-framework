"""Tool payload types — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Union

@dataclass(frozen=True)
class ToolCompletedPayload:
    duration_ms: float
    execution_id: str
    timestamp: float
    tool_name: str
    toolset_name: str


@dataclass(frozen=True)
class ToolErrorPayloadError:
    code: str
    message: str
    details: Any | None = None


@dataclass(frozen=True)
class ToolErrorPayload:
    error: ToolErrorPayloadError
    execution_id: str
    timestamp: float
    tool_name: str
    toolset_name: str


@dataclass(frozen=True)
class ToolExecuteRequestContextOverrides:
    adapter_id: str | None = None
    adapter_name: str | None = None
    agent_id: str | None = None
    constraints: dict[str, Any] | None = None
    cwd: str | None = None
    env: dict[str, Any] | None = None
    reasoning: str | None = None
    session_id: str | None = None
    tool_call_id: str | None = None
    turn_context: dict[str, Any] | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class ToolExecuteRequest:
    input: Any
    tool_name: str
    adapter_id: str | None = None
    adapter_name: str | None = None
    context_overrides: ToolExecuteRequestContextOverrides | None = None


@dataclass(frozen=True)
class ToolExecuteResponseVariantA:
    data: Any
    success: Literal[True]


@dataclass(frozen=True)
class ToolExecuteResponseVariantBError:
    code: str
    message: str
    details: Any | None = None


@dataclass(frozen=True)
class ToolExecuteResponseVariantB:
    error: ToolExecuteResponseVariantBError
    success: Literal[False]


@dataclass(frozen=True)
class ToolListRequest:
    adapter_id: str | None = None
    adapter_name: str | None = None
    toolset_name: str | None = None


@dataclass(frozen=True)
class ToolListResponseToolsItemAnnotations:
    destructive: bool | None = None
    idempotent: bool | None = None
    read_only: bool | None = None
    requires_approval: bool | None = None


@dataclass(frozen=True)
class ToolListResponseToolsItem:
    description: str
    name: str
    toolset_name: str
    annotations: ToolListResponseToolsItemAnnotations | None = None
    input_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class ToolListResponseToolsetsItem:
    description: str
    name: str
    tool_count: float
    version: str
    config_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class ToolListResponse:
    tools: list[ToolListResponseToolsItem]
    toolsets: list[ToolListResponseToolsetsItem]


@dataclass(frozen=True)
class ToolRegisteredPayload:
    tool_names: list[str]
    toolset_name: str
    toolset_version: str


@dataclass(frozen=True)
class ToolRegistryChangedPayload:
    reason: Literal["toolset-registered", "toolset-unregistered", "plugin-loaded", "plugin-unloaded"]
    revision: int
    toolset_name: str


@dataclass(frozen=True)
class ToolStartedPayload:
    execution_id: str
    timestamp: float
    tool_name: str
    toolset_name: str


ToolExecuteResponse = Union[ToolExecuteResponseVariantA, ToolExecuteResponseVariantB]

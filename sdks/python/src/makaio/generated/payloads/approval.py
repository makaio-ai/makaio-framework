"""Approval payload types — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

@dataclass(frozen=True)
class ApprovalRequestRequest:
    adapter_name: str
    agent_id: str
    created_at: float
    request_id: str
    session_id: str
    tool_call_id: str
    args: dict[str, Any] | None = None
    capabilities: list[Literal["file.read", "file.write", "file.delete", "search.content", "search.files", "search.web", "shell.execute", "network.request", "process.manage"]] | None = None
    persona_name: str | None = None
    profile_name: str | None = None
    reasoning: str | None = None
    risk_level: Literal["safe", "neutral", "destructive"] | None = None
    tool_name: str | None = None


@dataclass(frozen=True)
class ApprovalRequestResponse:
    pass


@dataclass(frozen=True)
class ApprovalResolveEnrichedPolicyRequest:
    tool_name: str
    persona_id: str | None = None
    profile_id: str | None = None


@dataclass(frozen=True)
class ApprovalResolveEnrichedPolicyResponse:
    action: Literal["allow", "deny", "ask"]
    allowed_directories: list[str] | None = None
    persona_name: str | None = None
    profile_name: str | None = None
    risk_level: Literal["safe", "neutral", "destructive"] | None = None

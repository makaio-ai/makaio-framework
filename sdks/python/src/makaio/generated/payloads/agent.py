"""Agent payload types — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Union

@dataclass(frozen=True)
class AgentCompletePayloadStructuredOutputValidationVariantA:
    status: Literal["passed"]


@dataclass(frozen=True)
class AgentCompletePayloadStructuredOutputValidationVariantB:
    status: Literal["enforced"]


@dataclass(frozen=True)
class AgentCompletePayloadStructuredOutputValidationVariantCErrorsItem:
    instance_path: str
    message: str
    schema_path: str


@dataclass(frozen=True)
class AgentCompletePayloadStructuredOutputValidationVariantC:
    errors: list[AgentCompletePayloadStructuredOutputValidationVariantCErrorsItem]
    status: Literal["failed"]


@dataclass(frozen=True)
class AgentCompletePayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    message_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    error: str | None = None
    error_category: Literal["rate_limit", "auth", "model_unavailable", "quota_exceeded"] | None = None
    message: str | None = None
    occurred_at: float | None = None
    outcome: Literal["completed", "superseded", "merged", "cancelled", "error", "rejected"] | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    structured_output_validation: Union[AgentCompletePayloadStructuredOutputValidationVariantA, AgentCompletePayloadStructuredOutputValidationVariantB, AgentCompletePayloadStructuredOutputValidationVariantC] | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentContextWindowUpdatedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    current_tokens: float
    level: Literal["ok", "warn", "critical"]
    max_tokens: float
    percentage: float
    adapter_session_id: str | None = None
    cached_tokens: float | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantADefinitionFieldsItemSourceHintsItem:
    kind: Literal["environment"]
    variable: str


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantADefinitionFieldsItem:
    id: str
    label: str
    required: bool
    secret: bool
    source_hints: list[AgentCredentialChangeRequestProviderContextAuthVariantADefinitionFieldsItemSourceHintsItem]
    description: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantADefinition:
    fields: list[AgentCredentialChangeRequestProviderContextAuthVariantADefinitionFieldsItem]
    id: str
    label: str
    mode: Literal["explicit"]
    description: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantAMethodVariantA:
    method_id: str
    owner: Literal["provider"]
    provider_definition_id: str


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantAMethodVariantB:
    client_id: str
    method_id: str
    owner: Literal["client"]


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantA:
    credential_refs: dict[str, Any]
    definition: AgentCredentialChangeRequestProviderContextAuthVariantADefinition
    method: Union[AgentCredentialChangeRequestProviderContextAuthVariantAMethodVariantA, AgentCredentialChangeRequestProviderContextAuthVariantAMethodVariantB]
    mode: Literal["explicit"]


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantBAccount:
    account_id: str
    manager_id: str


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantBDefinition:
    id: str
    label: str
    mode: Literal["inferred"]
    description: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantBMethod:
    client_id: str
    method_id: str
    owner: Literal["client"]


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantB:
    definition: AgentCredentialChangeRequestProviderContextAuthVariantBDefinition
    method: AgentCredentialChangeRequestProviderContextAuthVariantBMethod
    mode: Literal["inferred"]
    account: AgentCredentialChangeRequestProviderContextAuthVariantBAccount | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantCDefinition:
    id: str
    label: str
    mode: Literal["none"]
    description: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantCMethodVariantA:
    method_id: str
    owner: Literal["provider"]
    provider_definition_id: str


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantCMethodVariantB:
    client_id: str
    method_id: str
    owner: Literal["client"]


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextAuthVariantC:
    definition: AgentCredentialChangeRequestProviderContextAuthVariantCDefinition
    method: Union[AgentCredentialChangeRequestProviderContextAuthVariantCMethodVariantA, AgentCredentialChangeRequestProviderContextAuthVariantCMethodVariantB]
    mode: Literal["none"]


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContextEndpointOverrides:
    anthropic: str | None = None
    openai: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequestProviderContext:
    auth: Union[AgentCredentialChangeRequestProviderContextAuthVariantA, AgentCredentialChangeRequestProviderContextAuthVariantB, AgentCredentialChangeRequestProviderContextAuthVariantC]
    definition_id: str
    provider_config_id: str
    state: Literal["resolved"]
    capabilities: dict[str, Any] | None = None
    endpoint_overrides: AgentCredentialChangeRequestProviderContextEndpointOverrides | None = None


@dataclass(frozen=True)
class AgentCredentialChangeRequest:
    adapter_id: str
    adapter_name: str
    agent_id: str
    change_sequence: int
    provider_context: AgentCredentialChangeRequestProviderContext
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentCredentialChangeResponseVariantA:
    success: Literal[True]
    swapped: Literal[True]


@dataclass(frozen=True)
class AgentCredentialChangeResponseVariantB:
    reason: Literal["provider_mismatch", "stale_change", "turn_active", "credential_activation_failed:manager-unavailable", "credential_activation_failed:account-not-found", "credential_activation_failed:activation-failed", "credential_swap_failed"]
    success: Literal[False]


@dataclass(frozen=True)
class AgentCwdChangeRequest:
    adapter_id: str
    adapter_name: str
    agent_id: str
    new_cwd: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    skip_warning: bool | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentCwdChangeResponse:
    success: bool
    previous_cwd: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class AgentCwdChangedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    new_cwd: str
    previous_cwd: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentGetCapabilitiesRequest:
    agent_id: str


@dataclass(frozen=True)
class AgentGetCapabilitiesResponse:
    capabilities: list[str]
    native_tools: list[str]
    model: str | None = None


@dataclass(frozen=True)
class AgentIdlePayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentInterruptRequest:
    adapter_id: str
    adapter_name: str
    agent_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentInterruptResponseVariantA:
    success: Literal[True]


@dataclass(frozen=True)
class AgentInterruptResponseVariantB:
    reason: str
    success: Literal[False]


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextDirectToolsItem:
    enabled: bool
    exposed: bool
    exposure_mode: Literal["direct", "discovery", "hidden"]
    full_name: str
    input_schema: dict[str, Any]
    original_name: str
    server_name: str
    description: str | None = None
    enabled_at: int | None = None
    enabled_by: Literal["discovery", "toolset"] | None = None


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextDiscoverableToolsItem:
    enabled: bool
    exposed: bool
    exposure_mode: Literal["direct", "discovery", "hidden"]
    full_name: str
    input_schema: dict[str, Any]
    original_name: str
    server_name: str
    description: str | None = None
    enabled_at: int | None = None
    enabled_by: Literal["discovery", "toolset"] | None = None


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantA:
    command: str
    type: Literal["stdio"]
    always_load: bool | None = None
    args: list[str] | None = None
    env: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantBToolsItem:
    name: str
    permission_policy: Literal["always_allow", "always_ask", "always_deny"]


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantB:
    type: Literal["sse"]
    url: str
    always_load: bool | None = None
    headers: dict[str, Any] | None = None
    tools: list[AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantBToolsItem] | None = None


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantCToolsItem:
    name: str
    permission_policy: Literal["always_allow", "always_ask", "always_deny"]


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantC:
    type: Literal["http"]
    url: str
    always_load: bool | None = None
    headers: dict[str, Any] | None = None
    tools: list[AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantCToolsItem] | None = None


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContextServersItem:
    exposure_mode: Literal["direct", "discovery"]
    name: str
    transport: Union[AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantA, AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantB, AgentMcpServersSetRequestMcpSessionContextServersItemTransportVariantC]


@dataclass(frozen=True)
class AgentMcpServersSetRequestMcpSessionContext:
    direct_tools: list[AgentMcpServersSetRequestMcpSessionContextDirectToolsItem]
    discoverable_tools: list[AgentMcpServersSetRequestMcpSessionContextDiscoverableToolsItem]
    servers: list[AgentMcpServersSetRequestMcpSessionContextServersItem]
    session_id: str


@dataclass(frozen=True)
class AgentMcpServersSetRequest:
    adapter_id: str
    adapter_name: str
    agent_id: str
    mcp_session_context: AgentMcpServersSetRequestMcpSessionContext
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_active_behavior: Literal["reject", "stageForNextTurn"] | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentMcpServersSetResponse:
    success: bool
    reason: str | None = None
    staged: bool | None = None
    swapped: bool | None = None


@dataclass(frozen=True)
class AgentMessagePayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    content: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentMessageDeltaPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    text: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantADefinitionFieldsItemSourceHintsItem:
    kind: Literal["environment"]
    variable: str


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantADefinitionFieldsItem:
    id: str
    label: str
    required: bool
    secret: bool
    source_hints: list[AgentModelChangeRequestProviderContextVariantAAuthVariantADefinitionFieldsItemSourceHintsItem]
    description: str | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantADefinition:
    fields: list[AgentModelChangeRequestProviderContextVariantAAuthVariantADefinitionFieldsItem]
    id: str
    label: str
    mode: Literal["explicit"]
    description: str | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantAMethodVariantA:
    method_id: str
    owner: Literal["provider"]
    provider_definition_id: str


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantAMethodVariantB:
    client_id: str
    method_id: str
    owner: Literal["client"]


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantA:
    credential_refs: dict[str, Any]
    definition: AgentModelChangeRequestProviderContextVariantAAuthVariantADefinition
    method: Union[AgentModelChangeRequestProviderContextVariantAAuthVariantAMethodVariantA, AgentModelChangeRequestProviderContextVariantAAuthVariantAMethodVariantB]
    mode: Literal["explicit"]


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantBAccount:
    account_id: str
    manager_id: str


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantBDefinition:
    id: str
    label: str
    mode: Literal["inferred"]
    description: str | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantBMethod:
    client_id: str
    method_id: str
    owner: Literal["client"]


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantB:
    definition: AgentModelChangeRequestProviderContextVariantAAuthVariantBDefinition
    method: AgentModelChangeRequestProviderContextVariantAAuthVariantBMethod
    mode: Literal["inferred"]
    account: AgentModelChangeRequestProviderContextVariantAAuthVariantBAccount | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantCDefinition:
    id: str
    label: str
    mode: Literal["none"]
    description: str | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantCMethodVariantA:
    method_id: str
    owner: Literal["provider"]
    provider_definition_id: str


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantCMethodVariantB:
    client_id: str
    method_id: str
    owner: Literal["client"]


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAAuthVariantC:
    definition: AgentModelChangeRequestProviderContextVariantAAuthVariantCDefinition
    method: Union[AgentModelChangeRequestProviderContextVariantAAuthVariantCMethodVariantA, AgentModelChangeRequestProviderContextVariantAAuthVariantCMethodVariantB]
    mode: Literal["none"]


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantAEndpointOverrides:
    anthropic: str | None = None
    openai: str | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantA:
    auth: Union[AgentModelChangeRequestProviderContextVariantAAuthVariantA, AgentModelChangeRequestProviderContextVariantAAuthVariantB, AgentModelChangeRequestProviderContextVariantAAuthVariantC]
    definition_id: str
    provider_config_id: str
    state: Literal["resolved"]
    capabilities: dict[str, Any] | None = None
    endpoint_overrides: AgentModelChangeRequestProviderContextVariantAEndpointOverrides | None = None


@dataclass(frozen=True)
class AgentModelChangeRequestProviderContextVariantB:
    state: Literal["unresolved"]


@dataclass(frozen=True)
class AgentModelChangeRequest:
    adapter_id: str
    adapter_name: str
    agent_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    new_model: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    provider_context: Union[AgentModelChangeRequestProviderContextVariantA, AgentModelChangeRequestProviderContextVariantB] | None = None
    reasoning_effort: Literal["none", "low", "medium", "high", "extra-high"] | None = None
    session_id: str | None = None
    skip_warning: bool | None = None
    turn_active_behavior: Literal["reject", "stageForNextTurn"] | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentModelChangeResponse:
    success: bool
    applied_reasoning_effort: Literal["none", "low", "medium", "high", "extra-high"] | None = None
    model: str | None = None
    reason: str | None = None
    staged: bool | None = None
    supported_reasoning_levels: dict[str, Any] | None = None
    swapped: bool | None = None


@dataclass(frozen=True)
class AgentModelChangedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    new_model: str
    previous_model: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    new_reasoning_effort: Literal["none", "low", "medium", "high", "extra-high"] | None = None
    occurred_at: float | None = None
    previous_reasoning_effort: Literal["none", "low", "medium", "high", "extra-high"] | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentReasoningPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    content: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentReasoningDeltaPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    content: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentSendMessageRequestResponseSchema:
    schema: dict[str, Any]
    name: str | None = None
    strict: bool | None = None


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContextMessageHistoryItem:
    blocks: dict[str, Any]
    role: Literal["user", "assistant", "system"] | None = None


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContextNativeFork:
    source_adapter_session_id: str
    source_session_id: str
    fork_point_message_id: str | None = None
    target_working_directory: str | None = None


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContextNativeLocalityVariantA:
    kind: Literal["native"]


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContextNativeLocalityVariantB:
    kind: Literal["degrade"]
    reason: Literal["adapter-unsupported", "adapter-mismatch", "no-adapter-session", "missing-machine-id", "machine-mismatch", "cwd-mismatch", "transforms-present", "compression-present", "connector-swap", "mid-history-unsupported", "hybrid-imported-orchestrated", "native-attempt-failed", "agent-already-started", "fork-point-unresolvable"]


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContextNativeLocalityVariantC:
    kind: Literal["foreign"]
    machine_id: str


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContextRequestCorrelation:
    execution_id: str | None = None
    frame_id: str | None = None
    message_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentSendMessageRequestSessionContext:
    cache_strategy: Literal["auto", "systemPrompt", "fullPrefix"] | None = None
    extracted_context: Any | None = None
    has_compression: bool | None = None
    has_connector_swap: bool | None = None
    has_new_transforms: bool | None = None
    is_first_turn: bool | None = None
    message_history: list[AgentSendMessageRequestSessionContextMessageHistoryItem] | None = None
    native_fork: AgentSendMessageRequestSessionContextNativeFork | None = None
    native_locality: Union[AgentSendMessageRequestSessionContextNativeLocalityVariantA, AgentSendMessageRequestSessionContextNativeLocalityVariantB, AgentSendMessageRequestSessionContextNativeLocalityVariantC] | None = None
    request_correlation: AgentSendMessageRequestSessionContextRequestCorrelation | None = None
    turn_context: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentSendMessageRequest:
    adapter_id: str
    agent_id: str
    message: dict[str, Any]
    delivery_mode: Literal["enqueue", "immediate"] | None = None
    message_id: str | None = None
    response_schema: AgentSendMessageRequestResponseSchema | None = None
    session_context: AgentSendMessageRequestSessionContext | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentSendMessageResponse:
    message_id: str


@dataclass(frozen=True)
class AgentSessionClosedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    reason: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentStartedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    cwd: str | None
    model: str | None
    start_mode: Literal["fresh", "resume", "fork", "rotation"]
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantA:
    content: str
    type: Literal["text"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantBSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantBSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantB:
    source: Union[AgentStepFinishedPayloadContentVariantBSourceVariantA, AgentStepFinishedPayloadContentVariantBSourceVariantB]
    type: Literal["image"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantCSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantCSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantC:
    source: Union[AgentStepFinishedPayloadContentVariantCSourceVariantA, AgentStepFinishedPayloadContentVariantCSourceVariantB]
    type: Literal["document"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantDSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantDSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantD:
    attachment_type: Literal["file", "directory"]
    file_name: str
    file_path: str
    source: Union[AgentStepFinishedPayloadContentVariantDSourceVariantA, AgentStepFinishedPayloadContentVariantDSourceVariantB]
    type: Literal["attachment"]
    display_name: str | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantE:
    content: str
    type: Literal["reasoning"]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantF:
    args: dict[str, Any]
    name: str
    tool_call_id: str
    type: Literal["tool_call"]


@dataclass(frozen=True)
class AgentStepFinishedPayloadContentVariantG:
    output: str
    tool_call_id: str
    type: Literal["tool_output"]
    is_error: bool | None = None


@dataclass(frozen=True)
class AgentStepFinishedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    block_index: float
    content: Union[AgentStepFinishedPayloadContentVariantA, AgentStepFinishedPayloadContentVariantB, AgentStepFinishedPayloadContentVariantC, AgentStepFinishedPayloadContentVariantD, AgentStepFinishedPayloadContentVariantE, AgentStepFinishedPayloadContentVariantF, AgentStepFinishedPayloadContentVariantG]
    step_type: Literal["reasoning", "tool_use", "text"]
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentStepStartedPayloadBlockDataVariantA:
    tool_call_id: str
    tool_name: str
    type: Literal["tool_use"]


@dataclass(frozen=True)
class AgentStepStartedPayloadBlockDataVariantB:
    type: Literal["reasoning"]


@dataclass(frozen=True)
class AgentStepStartedPayloadBlockDataVariantC:
    type: Literal["text"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantA:
    content: str
    type: Literal["text"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantBSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantBSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantB:
    source: Union[AgentStepStartedPayloadContentVariantBSourceVariantA, AgentStepStartedPayloadContentVariantBSourceVariantB]
    type: Literal["image"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantCSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantCSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantC:
    source: Union[AgentStepStartedPayloadContentVariantCSourceVariantA, AgentStepStartedPayloadContentVariantCSourceVariantB]
    type: Literal["document"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantDSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantDSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantD:
    attachment_type: Literal["file", "directory"]
    file_name: str
    file_path: str
    source: Union[AgentStepStartedPayloadContentVariantDSourceVariantA, AgentStepStartedPayloadContentVariantDSourceVariantB]
    type: Literal["attachment"]
    display_name: str | None = None


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantE:
    content: str
    type: Literal["reasoning"]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantF:
    args: dict[str, Any]
    name: str
    tool_call_id: str
    type: Literal["tool_call"]


@dataclass(frozen=True)
class AgentStepStartedPayloadContentVariantG:
    output: str
    tool_call_id: str
    type: Literal["tool_output"]
    is_error: bool | None = None


@dataclass(frozen=True)
class AgentStepStartedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    block_index: float
    step_type: Literal["reasoning", "tool_use", "text"]
    adapter_session_id: str | None = None
    block_data: Union[AgentStepStartedPayloadBlockDataVariantA, AgentStepStartedPayloadBlockDataVariantB, AgentStepStartedPayloadBlockDataVariantC] | None = None
    client_id: str | None = None
    content: Union[AgentStepStartedPayloadContentVariantA, AgentStepStartedPayloadContentVariantB, AgentStepStartedPayloadContentVariantC, AgentStepStartedPayloadContentVariantD, AgentStepStartedPayloadContentVariantE, AgentStepStartedPayloadContentVariantF, AgentStepStartedPayloadContentVariantG] | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentStructuredOutputEnforceRequestResponseSchema:
    schema: dict[str, Any]
    name: str | None = None
    strict: bool | None = None


@dataclass(frozen=True)
class AgentStructuredOutputEnforceRequestValidationErrorsItem:
    instance_path: str
    message: str
    schema_path: str


@dataclass(frozen=True)
class AgentStructuredOutputEnforceRequest:
    adapter_has_capability: bool
    adapter_id: str
    agent_id: str
    raw_output: str
    response_schema: AgentStructuredOutputEnforceRequestResponseSchema
    validation_errors: list[AgentStructuredOutputEnforceRequestValidationErrorsItem]
    fallback_adapter_id: str | None = None
    fallback_adapter_name: str | None = None
    fallback_model: str | None = None
    session_id: str | None = None


@dataclass(frozen=True)
class AgentStructuredOutputEnforceResponseVariantA:
    enforced: Literal[True]
    output: str


@dataclass(frozen=True)
class AgentStructuredOutputEnforceResponseVariantB:
    enforced: Literal[False]
    error: str


@dataclass(frozen=True)
class AgentStructuredOutputRetryPolicyRequestResponseSchema:
    schema: dict[str, Any]
    name: str | None = None
    strict: bool | None = None


@dataclass(frozen=True)
class AgentStructuredOutputRetryPolicyRequest:
    adapter_capabilities: list[str]
    adapter_id: str
    agent_id: str
    attempt_number: int
    response_schema: AgentStructuredOutputRetryPolicyRequestResponseSchema


@dataclass(frozen=True)
class AgentStructuredOutputRetryPolicyResponse:
    max_retries: int


@dataclass(frozen=True)
class AgentToolCompletedPayloadArtifactResult:
    id: str
    kind: str
    revision: str


@dataclass(frozen=True)
class AgentToolCompletedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    result: dict[str, Any]
    tool_call_id: str
    tool_name: str
    adapter_session_id: str | None = None
    args: dict[str, Any] | None = None
    artifact_result: AgentToolCompletedPayloadArtifactResult | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    success: bool | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentToolOutputPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    output: str
    tool_call_id: str
    adapter_session_id: str | None = None
    args: dict[str, Any] | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    tool_name: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentToolStartedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    tool_call_id: str
    tool_name: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentToolUsePayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    tool_call_id: str
    tool_name: str
    adapter_session_id: str | None = None
    args: dict[str, Any] | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentToolApproveRequest:
    adapter_id: str
    adapter_name: str
    agent_id: str
    session_id: str
    tool_call_id: str
    adapter_session_id: str | None = None
    args: dict[str, Any] | None = None
    client_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    reasoning: str | None = None
    tool_name: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentToolApproveResponseVariantA:
    action: Literal["allow"]
    updated_input: dict[str, Any] | None = None
    updated_permissions: list[Any] | None = None


@dataclass(frozen=True)
class AgentToolApproveResponseVariantB:
    action: Literal["deny"]
    message: str
    should_abort: bool | None = None


@dataclass(frozen=True)
class AgentTurnCompletedPayloadStructuredOutputValidationVariantA:
    status: Literal["passed"]


@dataclass(frozen=True)
class AgentTurnCompletedPayloadStructuredOutputValidationVariantB:
    status: Literal["enforced"]


@dataclass(frozen=True)
class AgentTurnCompletedPayloadStructuredOutputValidationVariantCErrorsItem:
    instance_path: str
    message: str
    schema_path: str


@dataclass(frozen=True)
class AgentTurnCompletedPayloadStructuredOutputValidationVariantC:
    errors: list[AgentTurnCompletedPayloadStructuredOutputValidationVariantCErrorsItem]
    status: Literal["failed"]


@dataclass(frozen=True)
class AgentTurnCompletedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    message_id: str
    outcome: Literal["completed", "superseded", "merged", "cancelled", "error", "rejected"]
    adapter_session_id: str | None = None
    client_id: str | None = None
    error: str | None = None
    message: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    structured_output_validation: Union[AgentTurnCompletedPayloadStructuredOutputValidationVariantA, AgentTurnCompletedPayloadStructuredOutputValidationVariantB, AgentTurnCompletedPayloadStructuredOutputValidationVariantC] | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantA:
    content: str
    type: Literal["text"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantBSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantBSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantB:
    source: Union[AgentTurnStartedPayloadContentBlocksItemVariantBSourceVariantA, AgentTurnStartedPayloadContentBlocksItemVariantBSourceVariantB]
    type: Literal["image"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantCSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantCSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantC:
    source: Union[AgentTurnStartedPayloadContentBlocksItemVariantCSourceVariantA, AgentTurnStartedPayloadContentBlocksItemVariantCSourceVariantB]
    type: Literal["document"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantDSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantDSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantD:
    attachment_type: Literal["file", "directory"]
    file_name: str
    file_path: str
    source: Union[AgentTurnStartedPayloadContentBlocksItemVariantDSourceVariantA, AgentTurnStartedPayloadContentBlocksItemVariantDSourceVariantB]
    type: Literal["attachment"]
    display_name: str | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantE:
    content: str
    type: Literal["reasoning"]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantF:
    args: dict[str, Any]
    name: str
    tool_call_id: str
    type: Literal["tool_call"]


@dataclass(frozen=True)
class AgentTurnStartedPayloadContentBlocksItemVariantG:
    output: str
    tool_call_id: str
    type: Literal["tool_output"]
    is_error: bool | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayloadContent:
    blocks: list[Union[AgentTurnStartedPayloadContentBlocksItemVariantA, AgentTurnStartedPayloadContentBlocksItemVariantB, AgentTurnStartedPayloadContentBlocksItemVariantC, AgentTurnStartedPayloadContentBlocksItemVariantD, AgentTurnStartedPayloadContentBlocksItemVariantE, AgentTurnStartedPayloadContentBlocksItemVariantF, AgentTurnStartedPayloadContentBlocksItemVariantG]]
    role: Literal["user", "assistant", "system"]
    message: str | None = None


@dataclass(frozen=True)
class AgentTurnStartedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    content: AgentTurnStartedPayloadContent
    message_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    merged_from: list[str] | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentUsagePayloadQuota:
    limit: float
    overage: float
    type: str
    used: float
    reset_date: str | None = None


@dataclass(frozen=True)
class AgentUsagePayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    cost_unit_type: Literal["requests", "tokens"]
    cost_units: float
    granularity: Literal["provider-call", "turn-aggregate", "query-aggregate", "latest-request-gauge"]
    input_cached_tokens: float
    input_tokens: float
    model: str
    output_tokens: float
    provider: str
    reasoning_tokens: float
    total_tokens: float
    adapter_session_id: str | None = None
    audio_input_tokens: float | None = None
    audio_output_tokens: float | None = None
    cache_write_tokens: float | None = None
    client_id: str | None = None
    context_window: float | None = None
    cost: float | None = None
    cost_provenance: Literal["provider-reported", "client-reported", "estimated"] | None = None
    currency: str | None = None
    duration: float | None = None
    execution_id: str | None = None
    frame_id: str | None = None
    llm_call_id: str | None = None
    message_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    quota: AgentUsagePayloadQuota | None = None
    service_tier: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentUserMessageAcknowledgedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    message_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    merged_from: list[str] | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentUserMessageCompletedPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    message_id: str
    outcome: Literal["completed", "superseded", "merged", "cancelled", "error", "rejected"]
    adapter_session_id: str | None = None
    client_id: str | None = None
    error: str | None = None
    merged_into: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    superseded_by: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantA:
    content: str
    type: Literal["text"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantBSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantBSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantB:
    source: Union[AgentUserMessageSentPayloadContentBlocksItemVariantBSourceVariantA, AgentUserMessageSentPayloadContentBlocksItemVariantBSourceVariantB]
    type: Literal["image"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantCSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantCSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantC:
    source: Union[AgentUserMessageSentPayloadContentBlocksItemVariantCSourceVariantA, AgentUserMessageSentPayloadContentBlocksItemVariantCSourceVariantB]
    type: Literal["document"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantDSourceVariantA:
    data: str
    mime_type: str
    type: Literal["base64"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantDSourceVariantB:
    type: Literal["url"]
    url: str
    mime_type: str | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantD:
    attachment_type: Literal["file", "directory"]
    file_name: str
    file_path: str
    source: Union[AgentUserMessageSentPayloadContentBlocksItemVariantDSourceVariantA, AgentUserMessageSentPayloadContentBlocksItemVariantDSourceVariantB]
    type: Literal["attachment"]
    display_name: str | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantE:
    content: str
    type: Literal["reasoning"]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantF:
    args: dict[str, Any]
    name: str
    tool_call_id: str
    type: Literal["tool_call"]


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContentBlocksItemVariantG:
    output: str
    tool_call_id: str
    type: Literal["tool_output"]
    is_error: bool | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayloadContent:
    blocks: list[Union[AgentUserMessageSentPayloadContentBlocksItemVariantA, AgentUserMessageSentPayloadContentBlocksItemVariantB, AgentUserMessageSentPayloadContentBlocksItemVariantC, AgentUserMessageSentPayloadContentBlocksItemVariantD, AgentUserMessageSentPayloadContentBlocksItemVariantE, AgentUserMessageSentPayloadContentBlocksItemVariantF, AgentUserMessageSentPayloadContentBlocksItemVariantG]]
    role: Literal["user", "assistant", "system"]
    message: str | None = None


@dataclass(frozen=True)
class AgentUserMessageSentPayload:
    adapter_id: str
    adapter_name: str
    agent_id: str
    content: AgentUserMessageSentPayloadContent
    delivery_mode: Literal["enqueue", "immediate", "replace"]
    message_id: str
    adapter_session_id: str | None = None
    client_id: str | None = None
    occurred_at: float | None = None
    provider_config_id: str | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AgentValidateModelChangeRequest:
    agent_id: str
    current_model: str
    next_model: str


@dataclass(frozen=True)
class AgentValidateModelChangeResponse:
    proceed: bool
    request_edit_history: bool | None = None


AgentCredentialChangeResponse = Union[AgentCredentialChangeResponseVariantA, AgentCredentialChangeResponseVariantB]


AgentInterruptResponse = Union[AgentInterruptResponseVariantA, AgentInterruptResponseVariantB]


AgentStructuredOutputEnforceResponse = Union[AgentStructuredOutputEnforceResponseVariantA, AgentStructuredOutputEnforceResponseVariantB]


AgentToolApproveResponse = Union[AgentToolApproveResponseVariantA, AgentToolApproveResponseVariantB]

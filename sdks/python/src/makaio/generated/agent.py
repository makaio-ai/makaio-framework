"""Agent namespace subjects — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from makaio.types import EventSubject, RequestSubject
from makaio.generated.payloads.agent import (
    AgentCompletePayload,
    AgentContextWindowUpdatedPayload,
    AgentCredentialChangeRequest,
    AgentCredentialChangeResponse,
    AgentCwdChangeRequest,
    AgentCwdChangeResponse,
    AgentCwdChangedPayload,
    AgentGetCapabilitiesRequest,
    AgentGetCapabilitiesResponse,
    AgentIdlePayload,
    AgentInterruptRequest,
    AgentInterruptResponse,
    AgentMcpServersSetRequest,
    AgentMcpServersSetResponse,
    AgentMessagePayload,
    AgentMessageDeltaPayload,
    AgentModelChangeRequest,
    AgentModelChangeResponse,
    AgentModelChangedPayload,
    AgentReasoningPayload,
    AgentReasoningDeltaPayload,
    AgentSendMessageRequest,
    AgentSendMessageResponse,
    AgentSessionClosedPayload,
    AgentStartedPayload,
    AgentStepFinishedPayload,
    AgentStepStartedPayload,
    AgentToolCompletedPayload,
    AgentToolOutputPayload,
    AgentToolStartedPayload,
    AgentToolUsePayload,
    AgentToolApproveRequest,
    AgentToolApproveResponse,
    AgentTurnCompletedPayload,
    AgentTurnStartedPayload,
    AgentUsagePayload,
    AgentUserMessageAcknowledgedPayload,
    AgentUserMessageCompletedPayload,
    AgentUserMessageSentPayload,
    AgentValidateModelChangeRequest,
    AgentValidateModelChangeResponse,
)

complete: EventSubject[AgentCompletePayload] = EventSubject("agent.complete", payload_type=AgentCompletePayload)
context_window_updated: EventSubject[AgentContextWindowUpdatedPayload] = EventSubject("agent.contextWindow.updated", payload_type=AgentContextWindowUpdatedPayload)
credential_change: RequestSubject[AgentCredentialChangeRequest, AgentCredentialChangeResponse] = RequestSubject("agent.credential.change", request_type=AgentCredentialChangeRequest, response_type=AgentCredentialChangeResponse)
cwd_change: RequestSubject[AgentCwdChangeRequest, AgentCwdChangeResponse] = RequestSubject("agent.cwd.change", request_type=AgentCwdChangeRequest, response_type=AgentCwdChangeResponse)
cwd_changed: EventSubject[AgentCwdChangedPayload] = EventSubject("agent.cwd.changed", payload_type=AgentCwdChangedPayload)
get_capabilities: RequestSubject[AgentGetCapabilitiesRequest, AgentGetCapabilitiesResponse] = RequestSubject("agent.getCapabilities", request_type=AgentGetCapabilitiesRequest, response_type=AgentGetCapabilitiesResponse)
idle: EventSubject[AgentIdlePayload] = EventSubject("agent.idle", payload_type=AgentIdlePayload)
interrupt: RequestSubject[AgentInterruptRequest, AgentInterruptResponse] = RequestSubject("agent.interrupt", request_type=AgentInterruptRequest, response_type=AgentInterruptResponse)
mcp_servers_set: RequestSubject[AgentMcpServersSetRequest, AgentMcpServersSetResponse] = RequestSubject("agent.mcp.servers.set", request_type=AgentMcpServersSetRequest, response_type=AgentMcpServersSetResponse)
message: EventSubject[AgentMessagePayload] = EventSubject("agent.message", payload_type=AgentMessagePayload)
message_delta: EventSubject[AgentMessageDeltaPayload] = EventSubject("agent.message_delta", payload_type=AgentMessageDeltaPayload)
model_change: RequestSubject[AgentModelChangeRequest, AgentModelChangeResponse] = RequestSubject("agent.model.change", request_type=AgentModelChangeRequest, response_type=AgentModelChangeResponse)
model_changed: EventSubject[AgentModelChangedPayload] = EventSubject("agent.model.changed", payload_type=AgentModelChangedPayload)
reasoning: EventSubject[AgentReasoningPayload] = EventSubject("agent.reasoning", payload_type=AgentReasoningPayload)
reasoning_delta: EventSubject[AgentReasoningDeltaPayload] = EventSubject("agent.reasoning_delta", payload_type=AgentReasoningDeltaPayload)
send_message: RequestSubject[AgentSendMessageRequest, AgentSendMessageResponse] = RequestSubject("agent.sendMessage", request_type=AgentSendMessageRequest, response_type=AgentSendMessageResponse)
session_closed: EventSubject[AgentSessionClosedPayload] = EventSubject("agent.session.closed", payload_type=AgentSessionClosedPayload)
started: EventSubject[AgentStartedPayload] = EventSubject("agent.started", payload_type=AgentStartedPayload)
step_finished: EventSubject[AgentStepFinishedPayload] = EventSubject("agent.step.finished", payload_type=AgentStepFinishedPayload)
step_started: EventSubject[AgentStepStartedPayload] = EventSubject("agent.step.started", payload_type=AgentStepStartedPayload)
tool_completed: EventSubject[AgentToolCompletedPayload] = EventSubject("agent.tool.completed", payload_type=AgentToolCompletedPayload)
tool_output: EventSubject[AgentToolOutputPayload] = EventSubject("agent.tool.output", payload_type=AgentToolOutputPayload)
tool_started: EventSubject[AgentToolStartedPayload] = EventSubject("agent.tool.started", payload_type=AgentToolStartedPayload)
tool_use: EventSubject[AgentToolUsePayload] = EventSubject("agent.tool.use", payload_type=AgentToolUsePayload)
tool_approve: RequestSubject[AgentToolApproveRequest, AgentToolApproveResponse] = RequestSubject("agent.toolApprove", request_type=AgentToolApproveRequest, response_type=AgentToolApproveResponse)
turn_completed: EventSubject[AgentTurnCompletedPayload] = EventSubject("agent.turn.completed", payload_type=AgentTurnCompletedPayload)
turn_started: EventSubject[AgentTurnStartedPayload] = EventSubject("agent.turn.started", payload_type=AgentTurnStartedPayload)
usage: EventSubject[AgentUsagePayload] = EventSubject("agent.usage", payload_type=AgentUsagePayload)
user_message_acknowledged: EventSubject[AgentUserMessageAcknowledgedPayload] = EventSubject("agent.user_message.acknowledged", payload_type=AgentUserMessageAcknowledgedPayload)
user_message_completed: EventSubject[AgentUserMessageCompletedPayload] = EventSubject("agent.user_message.completed", payload_type=AgentUserMessageCompletedPayload)
user_message_sent: EventSubject[AgentUserMessageSentPayload] = EventSubject("agent.user_message.sent", payload_type=AgentUserMessageSentPayload)
validate_model_change: RequestSubject[AgentValidateModelChangeRequest, AgentValidateModelChangeResponse] = RequestSubject("agent.validateModelChange", request_type=AgentValidateModelChangeRequest, response_type=AgentValidateModelChangeResponse)

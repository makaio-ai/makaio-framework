"""Session namespace subjects — generated from makaio-bus-protocol.json."""

from __future__ import annotations

from makaio.types import EventSubject, RequestSubject
from makaio.generated.payloads.session import (
    SessionAgentAddedPayload,
    SessionCreatedPayload,
    SessionRestartAgentsRequest,
    SessionRestartAgentsResponse,
    SessionSendMessageRequest,
    SessionSendMessageResponse,
    SessionTurnAwaitRequest,
    SessionTurnAwaitResponse,
    SessionTurnCompletedPayload,
    SessionTurnStartedPayload,
    SessionUserMessageSentPayload,
)

agent_added: EventSubject[SessionAgentAddedPayload] = EventSubject("session.agent.added", payload_type=SessionAgentAddedPayload)
created: EventSubject[SessionCreatedPayload] = EventSubject("session.created", payload_type=SessionCreatedPayload)
restart_agents: RequestSubject[SessionRestartAgentsRequest, SessionRestartAgentsResponse] = RequestSubject("session.restartAgents", request_type=SessionRestartAgentsRequest, response_type=SessionRestartAgentsResponse)
send_message: RequestSubject[SessionSendMessageRequest, SessionSendMessageResponse] = RequestSubject("session.sendMessage", request_type=SessionSendMessageRequest, response_type=SessionSendMessageResponse)
turn_await: RequestSubject[SessionTurnAwaitRequest, SessionTurnAwaitResponse] = RequestSubject("session.turn.await", request_type=SessionTurnAwaitRequest, response_type=SessionTurnAwaitResponse)
turn_completed: EventSubject[SessionTurnCompletedPayload] = EventSubject("session.turn.completed", payload_type=SessionTurnCompletedPayload)
turn_started: EventSubject[SessionTurnStartedPayload] = EventSubject("session.turn.started", payload_type=SessionTurnStartedPayload)
user_message_sent: EventSubject[SessionUserMessageSentPayload] = EventSubject("session.user_message.sent", payload_type=SessionUserMessageSentPayload)

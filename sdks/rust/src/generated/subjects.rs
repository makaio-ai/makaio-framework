// <generated-subjects>
//! Subject bindings generated from `sdks/manifest/makaio-bus-protocol.json`.
#![allow(non_snake_case)]

use crate::bus::{EventSubject, RequestSubject};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A manifest subject exported into the Rust SDK.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolSubject {
    pub kind: SubjectKind,
    pub namespace: &'static str,
    pub subject: &'static str,
    pub full_subject: &'static str,
}

/// Runtime kind for a protocol subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubjectKind {
    Event,
    Request,
}

pub mod agent {
    use super::{EventSubject, RequestSubject, Value};

    pub const COMPLETE: &str = "agent.complete";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Complete;
    impl EventSubject for Complete {
        type Payload = Value;
        const SUBJECT: &'static str = COMPLETE;
    }

    pub const CONTEXT_WINDOW_UPDATED: &str = "agent.contextWindow.updated";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ContextWindowUpdated;
    impl EventSubject for ContextWindowUpdated {
        type Payload = Value;
        const SUBJECT: &'static str = CONTEXT_WINDOW_UPDATED;
    }

    pub const CREDENTIAL_CHANGE: &str = "agent.credential.change";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct CredentialChange;
    impl RequestSubject for CredentialChange {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = CREDENTIAL_CHANGE;
    }

    pub const CWD_CHANGE: &str = "agent.cwd.change";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct CwdChange;
    impl RequestSubject for CwdChange {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = CWD_CHANGE;
    }

    pub const CWD_CHANGED: &str = "agent.cwd.changed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct CwdChanged;
    impl EventSubject for CwdChanged {
        type Payload = Value;
        const SUBJECT: &'static str = CWD_CHANGED;
    }

    pub const GET_CAPABILITIES: &str = "agent.getCapabilities";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct GetCapabilities;
    impl RequestSubject for GetCapabilities {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = GET_CAPABILITIES;
    }

    pub const IDLE: &str = "agent.idle";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Idle;
    impl EventSubject for Idle {
        type Payload = Value;
        const SUBJECT: &'static str = IDLE;
    }

    pub const INTERRUPT: &str = "agent.interrupt";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Interrupt;
    impl RequestSubject for Interrupt {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = INTERRUPT;
    }

    pub const MCP_SERVERS_SET: &str = "agent.mcp.servers.set";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct McpServersSet;
    impl RequestSubject for McpServersSet {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = MCP_SERVERS_SET;
    }

    pub const MESSAGE: &str = "agent.message";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Message;
    impl EventSubject for Message {
        type Payload = super::AgentMessagePayload;
        const SUBJECT: &'static str = MESSAGE;
    }

    pub const MESSAGE_DELTA: &str = "agent.message_delta";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct MessageDelta;
    impl EventSubject for MessageDelta {
        type Payload = Value;
        const SUBJECT: &'static str = MESSAGE_DELTA;
    }

    pub const MODEL_CHANGE: &str = "agent.model.change";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ModelChange;
    impl RequestSubject for ModelChange {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = MODEL_CHANGE;
    }

    pub const MODEL_CHANGED: &str = "agent.model.changed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ModelChanged;
    impl EventSubject for ModelChanged {
        type Payload = Value;
        const SUBJECT: &'static str = MODEL_CHANGED;
    }

    pub const REASONING: &str = "agent.reasoning";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Reasoning;
    impl EventSubject for Reasoning {
        type Payload = Value;
        const SUBJECT: &'static str = REASONING;
    }

    pub const REASONING_DELTA: &str = "agent.reasoning_delta";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ReasoningDelta;
    impl EventSubject for ReasoningDelta {
        type Payload = Value;
        const SUBJECT: &'static str = REASONING_DELTA;
    }

    pub const SEND_MESSAGE: &str = "agent.sendMessage";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SendMessage;
    impl RequestSubject for SendMessage {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = SEND_MESSAGE;
    }

    pub const SESSION_CLOSED: &str = "agent.session.closed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SessionClosed;
    impl EventSubject for SessionClosed {
        type Payload = Value;
        const SUBJECT: &'static str = SESSION_CLOSED;
    }

    pub const STARTED: &str = "agent.started";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Started;
    impl EventSubject for Started {
        type Payload = super::AgentStartedPayload;
        const SUBJECT: &'static str = STARTED;
    }

    pub const STEP_FINISHED: &str = "agent.step.finished";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct StepFinished;
    impl EventSubject for StepFinished {
        type Payload = Value;
        const SUBJECT: &'static str = STEP_FINISHED;
    }

    pub const STEP_STARTED: &str = "agent.step.started";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct StepStarted;
    impl EventSubject for StepStarted {
        type Payload = Value;
        const SUBJECT: &'static str = STEP_STARTED;
    }

    pub const STRUCTURED_OUTPUT_ENFORCE: &str = "agent.structuredOutput.enforce";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct StructuredOutputEnforce;
    impl RequestSubject for StructuredOutputEnforce {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = STRUCTURED_OUTPUT_ENFORCE;
    }

    pub const STRUCTURED_OUTPUT_RETRY_POLICY: &str = "agent.structuredOutput.retryPolicy";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct StructuredOutputRetryPolicy;
    impl RequestSubject for StructuredOutputRetryPolicy {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = STRUCTURED_OUTPUT_RETRY_POLICY;
    }

    pub const TOOL_COMPLETED: &str = "agent.tool.completed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ToolCompleted;
    impl EventSubject for ToolCompleted {
        type Payload = Value;
        const SUBJECT: &'static str = TOOL_COMPLETED;
    }

    pub const TOOL_OUTPUT: &str = "agent.tool.output";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ToolOutput;
    impl EventSubject for ToolOutput {
        type Payload = Value;
        const SUBJECT: &'static str = TOOL_OUTPUT;
    }

    pub const TOOL_STARTED: &str = "agent.tool.started";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ToolStarted;
    impl EventSubject for ToolStarted {
        type Payload = Value;
        const SUBJECT: &'static str = TOOL_STARTED;
    }

    pub const TOOL_USE: &str = "agent.tool.use";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ToolUse;
    impl EventSubject for ToolUse {
        type Payload = Value;
        const SUBJECT: &'static str = TOOL_USE;
    }

    pub const TOOL_APPROVE: &str = "agent.toolApprove";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ToolApprove;
    impl RequestSubject for ToolApprove {
        type Request = super::AgentToolApproveRequest;
        type Response = super::AgentToolApproveResponse;
        const SUBJECT: &'static str = TOOL_APPROVE;
    }

    pub const TURN_COMPLETED: &str = "agent.turn.completed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TurnCompleted;
    impl EventSubject for TurnCompleted {
        type Payload = Value;
        const SUBJECT: &'static str = TURN_COMPLETED;
    }

    pub const TURN_STARTED: &str = "agent.turn.started";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TurnStarted;
    impl EventSubject for TurnStarted {
        type Payload = Value;
        const SUBJECT: &'static str = TURN_STARTED;
    }

    pub const USAGE: &str = "agent.usage";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Usage;
    impl EventSubject for Usage {
        type Payload = Value;
        const SUBJECT: &'static str = USAGE;
    }

    pub const USER_MESSAGE_ACKNOWLEDGED: &str = "agent.user_message.acknowledged";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct UserMessageAcknowledged;
    impl EventSubject for UserMessageAcknowledged {
        type Payload = Value;
        const SUBJECT: &'static str = USER_MESSAGE_ACKNOWLEDGED;
    }

    pub const USER_MESSAGE_COMPLETED: &str = "agent.user_message.completed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct UserMessageCompleted;
    impl EventSubject for UserMessageCompleted {
        type Payload = Value;
        const SUBJECT: &'static str = USER_MESSAGE_COMPLETED;
    }

    pub const USER_MESSAGE_SENT: &str = "agent.user_message.sent";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct UserMessageSent;
    impl EventSubject for UserMessageSent {
        type Payload = Value;
        const SUBJECT: &'static str = USER_MESSAGE_SENT;
    }

    pub const VALIDATE_MODEL_CHANGE: &str = "agent.validateModelChange";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ValidateModelChange;
    impl RequestSubject for ValidateModelChange {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = VALIDATE_MODEL_CHANGE;
    }
}

pub mod approval {
    use super::{RequestSubject, Value};

    pub const REQUEST: &str = "approval.request";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Request;
    impl RequestSubject for Request {
        type Request = super::ApprovalRequest;
        type Response = super::ApprovalResponse;
        const SUBJECT: &'static str = REQUEST;
    }

    pub const RESOLVE_ENRICHED_POLICY: &str = "approval.resolveEnrichedPolicy";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ResolveEnrichedPolicy;
    impl RequestSubject for ResolveEnrichedPolicy {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = RESOLVE_ENRICHED_POLICY;
    }
}

pub mod session {
    use super::{EventSubject, RequestSubject, Value};

    pub const AGENT_ADDED: &str = "session.agent.added";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct AgentAdded;
    impl EventSubject for AgentAdded {
        type Payload = Value;
        const SUBJECT: &'static str = AGENT_ADDED;
    }

    pub const CREATED: &str = "session.created";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Created;
    impl EventSubject for Created {
        type Payload = Value;
        const SUBJECT: &'static str = CREATED;
    }

    pub const RESTART_AGENTS: &str = "session.restartAgents";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct RestartAgents;
    impl RequestSubject for RestartAgents {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = RESTART_AGENTS;
    }

    pub const SEND_MESSAGE: &str = "session.sendMessage";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct SendMessage;
    impl RequestSubject for SendMessage {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = SEND_MESSAGE;
    }

    pub const TURN_AWAIT: &str = "session.turn.await";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TurnAwait;
    impl RequestSubject for TurnAwait {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = TURN_AWAIT;
    }

    pub const TURN_COMPLETED: &str = "session.turn.completed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TurnCompleted;
    impl EventSubject for TurnCompleted {
        type Payload = Value;
        const SUBJECT: &'static str = TURN_COMPLETED;
    }

    pub const TURN_STARTED: &str = "session.turn.started";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TurnStarted;
    impl EventSubject for TurnStarted {
        type Payload = Value;
        const SUBJECT: &'static str = TURN_STARTED;
    }

    pub const USER_MESSAGE_SENT: &str = "session.user_message.sent";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct UserMessageSent;
    impl EventSubject for UserMessageSent {
        type Payload = Value;
        const SUBJECT: &'static str = USER_MESSAGE_SENT;
    }
}

pub mod tool {
    use super::{EventSubject, RequestSubject, Value};

    pub const COMPLETED: &str = "tool.completed";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Completed;
    impl EventSubject for Completed {
        type Payload = super::ToolCompletedPayload;
        const SUBJECT: &'static str = COMPLETED;
    }

    pub const ERROR: &str = "tool.error";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Error;
    impl EventSubject for Error {
        type Payload = super::ToolErrorPayload;
        const SUBJECT: &'static str = ERROR;
    }

    pub const EXECUTE: &str = "tool.execute";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Execute;
    impl RequestSubject for Execute {
        type Request = super::ToolExecuteRequest;
        type Response = super::ToolExecuteResponse;
        const SUBJECT: &'static str = EXECUTE;
    }

    pub const LIST: &str = "tool.list";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct List;
    impl RequestSubject for List {
        type Request = Value;
        type Response = Value;
        const SUBJECT: &'static str = LIST;
    }

    pub const REGISTERED: &str = "tool.registered";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Registered;
    impl EventSubject for Registered {
        type Payload = super::ToolRegisteredPayload;
        const SUBJECT: &'static str = REGISTERED;
    }

    pub const REGISTRY_CHANGED: &str = "tool.registryChanged";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct RegistryChanged;
    impl EventSubject for RegistryChanged {
        type Payload = super::ToolRegistryChangedPayload;
        const SUBJECT: &'static str = REGISTRY_CHANGED;
    }

    pub const STARTED: &str = "tool.started";

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Started;
    impl EventSubject for Started {
        type Payload = super::ToolLifecyclePayload;
        const SUBJECT: &'static str = STARTED;
    }
}

pub const SUBJECTS: &[ProtocolSubject] = &[
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "complete",
        full_subject: agent::COMPLETE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "contextWindow.updated",
        full_subject: agent::CONTEXT_WINDOW_UPDATED,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "credential.change",
        full_subject: agent::CREDENTIAL_CHANGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "cwd.change",
        full_subject: agent::CWD_CHANGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "cwd.changed",
        full_subject: agent::CWD_CHANGED,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "getCapabilities",
        full_subject: agent::GET_CAPABILITIES,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "idle",
        full_subject: agent::IDLE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "interrupt",
        full_subject: agent::INTERRUPT,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "mcp.servers.set",
        full_subject: agent::MCP_SERVERS_SET,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "message",
        full_subject: agent::MESSAGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "message_delta",
        full_subject: agent::MESSAGE_DELTA,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "model.change",
        full_subject: agent::MODEL_CHANGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "model.changed",
        full_subject: agent::MODEL_CHANGED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "reasoning",
        full_subject: agent::REASONING,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "reasoning_delta",
        full_subject: agent::REASONING_DELTA,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "sendMessage",
        full_subject: agent::SEND_MESSAGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "session.closed",
        full_subject: agent::SESSION_CLOSED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "started",
        full_subject: agent::STARTED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "step.finished",
        full_subject: agent::STEP_FINISHED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "step.started",
        full_subject: agent::STEP_STARTED,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "structuredOutput.enforce",
        full_subject: agent::STRUCTURED_OUTPUT_ENFORCE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "structuredOutput.retryPolicy",
        full_subject: agent::STRUCTURED_OUTPUT_RETRY_POLICY,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "tool.completed",
        full_subject: agent::TOOL_COMPLETED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "tool.output",
        full_subject: agent::TOOL_OUTPUT,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "tool.started",
        full_subject: agent::TOOL_STARTED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "tool.use",
        full_subject: agent::TOOL_USE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "toolApprove",
        full_subject: agent::TOOL_APPROVE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "turn.completed",
        full_subject: agent::TURN_COMPLETED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "turn.started",
        full_subject: agent::TURN_STARTED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "usage",
        full_subject: agent::USAGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "user_message.acknowledged",
        full_subject: agent::USER_MESSAGE_ACKNOWLEDGED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "user_message.completed",
        full_subject: agent::USER_MESSAGE_COMPLETED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "agent",
        subject: "user_message.sent",
        full_subject: agent::USER_MESSAGE_SENT,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "agent",
        subject: "validateModelChange",
        full_subject: agent::VALIDATE_MODEL_CHANGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "approval",
        subject: "request",
        full_subject: approval::REQUEST,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "approval",
        subject: "resolveEnrichedPolicy",
        full_subject: approval::RESOLVE_ENRICHED_POLICY,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "session",
        subject: "agent.added",
        full_subject: session::AGENT_ADDED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "session",
        subject: "created",
        full_subject: session::CREATED,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "session",
        subject: "restartAgents",
        full_subject: session::RESTART_AGENTS,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "session",
        subject: "sendMessage",
        full_subject: session::SEND_MESSAGE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "session",
        subject: "turn.await",
        full_subject: session::TURN_AWAIT,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "session",
        subject: "turn.completed",
        full_subject: session::TURN_COMPLETED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "session",
        subject: "turn.started",
        full_subject: session::TURN_STARTED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "session",
        subject: "user_message.sent",
        full_subject: session::USER_MESSAGE_SENT,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "tool",
        subject: "completed",
        full_subject: tool::COMPLETED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "tool",
        subject: "error",
        full_subject: tool::ERROR,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "tool",
        subject: "execute",
        full_subject: tool::EXECUTE,
    },
    ProtocolSubject {
        kind: SubjectKind::Request,
        namespace: "tool",
        subject: "list",
        full_subject: tool::LIST,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "tool",
        subject: "registered",
        full_subject: tool::REGISTERED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "tool",
        subject: "registryChanged",
        full_subject: tool::REGISTRY_CHANGED,
    },
    ProtocolSubject {
        kind: SubjectKind::Event,
        namespace: "tool",
        subject: "started",
        full_subject: tool::STARTED,
    },
];
// </generated-subjects>

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessagePayload {
    pub agent_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub adapter_session_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// Agent start mode carried in `agent.started` events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStartMode {
    Fresh,
    Resume,
    Fork,
    Rotation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartedPayload {
    pub agent_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub adapter_session_id: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub start_mode: AgentStartMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolApproveRequest {
    pub agent_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub session_id: String,
    pub adapter_session_id: String,
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub args: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum AgentToolApproveResponse {
    #[serde(rename = "allow")]
    Allow {
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<Map<String, Value>>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        updated_permissions: Vec<Value>,
    },
    #[serde(rename = "deny")]
    Deny {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        should_abort: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub tool_call_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub adapter_name: String,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub args: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<ApprovalCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_level: Option<RiskLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalCapability {
    #[serde(rename = "file.read")]
    FileRead,
    #[serde(rename = "file.write")]
    FileWrite,
    #[serde(rename = "file.delete")]
    FileDelete,
    #[serde(rename = "search.content")]
    SearchContent,
    #[serde(rename = "search.files")]
    SearchFiles,
    #[serde(rename = "search.web")]
    SearchWeb,
    #[serde(rename = "shell.execute")]
    ShellExecute,
    #[serde(rename = "network.request")]
    NetworkRequest,
    #[serde(rename = "process.manage")]
    ProcessManage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RiskLevel {
    Safe,
    Neutral,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ApprovalResponse {
    #[serde(rename = "allow")]
    Allow {
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<Map<String, Value>>,
    },
    #[serde(rename = "deny")]
    Deny {
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecuteRequest {
    pub tool_name: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_overrides: Option<ToolExecutionContextOverrides>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionContextOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub env: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub constraints: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub turn_context: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ToolExecuteResponse {
    Success(ToolExecuteSuccessResponse),
    Failure(ToolExecuteFailureResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecuteSuccessResponse {
    pub success: bool,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecuteFailureResponse {
    pub success: bool,
    pub error: ToolErrorDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolLifecyclePayload {
    pub tool_name: String,
    pub toolset_name: String,
    pub execution_id: String,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCompletedPayload {
    pub tool_name: String,
    pub toolset_name: String,
    pub execution_id: String,
    pub timestamp: f64,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolErrorPayload {
    pub tool_name: String,
    pub toolset_name: String,
    pub execution_id: String,
    pub timestamp: f64,
    pub error: ToolErrorDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegisteredPayload {
    pub toolset_name: String,
    pub toolset_version: String,
    pub tool_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRegistryChangedPayload {
    pub revision: u64,
    pub reason: ToolRegistryChangedReason,
    pub toolset_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ToolRegistryChangedReason {
    ToolsetRegistered,
    ToolsetUnregistered,
    PluginLoaded,
    PluginUnloaded,
}

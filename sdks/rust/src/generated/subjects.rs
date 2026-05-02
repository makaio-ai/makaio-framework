// <generated-subjects>
//! Subject bindings generated from `framework/sdks/manifest/makaio-bus-protocol.json`.
#![allow(non_snake_case)]

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
    pub const COMPLETE: &str = "agent.complete";
    pub const CONTEXT_WINDOW_UPDATED: &str = "agent.contextWindow.updated";
    pub const CREDENTIAL_CHANGE: &str = "agent.credential.change";
    pub const CWD_CHANGE: &str = "agent.cwd.change";
    pub const CWD_CHANGED: &str = "agent.cwd.changed";
    pub const GET_CAPABILITIES: &str = "agent.getCapabilities";
    pub const IDLE: &str = "agent.idle";
    pub const MESSAGE: &str = "agent.message";
    pub const MESSAGE_DELTA: &str = "agent.message_delta";
    pub const MODEL_CHANGE: &str = "agent.model.change";
    pub const MODEL_CHANGED: &str = "agent.model.changed";
    pub const REASONING: &str = "agent.reasoning";
    pub const REASONING_DELTA: &str = "agent.reasoning_delta";
    pub const SEND_MESSAGE: &str = "agent.sendMessage";
    pub const SESSION_CLOSED: &str = "agent.session.closed";
    pub const STARTED: &str = "agent.started";
    pub const STEP_FINISHED: &str = "agent.step.finished";
    pub const STEP_STARTED: &str = "agent.step.started";
    pub const TOOL_COMPLETED: &str = "agent.tool.completed";
    pub const TOOL_OUTPUT: &str = "agent.tool.output";
    pub const TOOL_STARTED: &str = "agent.tool.started";
    pub const TOOL_USE: &str = "agent.tool.use";
    pub const TOOL_APPROVE: &str = "agent.toolApprove";
    pub const TURN_COMPLETED: &str = "agent.turn.completed";
    pub const TURN_STARTED: &str = "agent.turn.started";
    pub const USAGE: &str = "agent.usage";
    pub const USER_MESSAGE_ACKNOWLEDGED: &str = "agent.user_message.acknowledged";
    pub const USER_MESSAGE_COMPLETED: &str = "agent.user_message.completed";
    pub const USER_MESSAGE_SENT: &str = "agent.user_message.sent";
    pub const VALIDATE_MODEL_CHANGE: &str = "agent.validateModelChange";
}

pub mod approval {
    pub const REQUEST: &str = "approval.request";
    pub const RESOLVE_ENRICHED_POLICY: &str = "approval.resolveEnrichedPolicy";
}

pub mod session {
    pub const AGENT_ADDED: &str = "session.agent.added";
    pub const CREATED: &str = "session.created";
    pub const SEND_MESSAGE: &str = "session.sendMessage";
    pub const TURN_COMPLETED: &str = "session.turn.completed";
    pub const TURN_STARTED: &str = "session.turn.started";
    pub const USER_MESSAGE_SENT: &str = "session.user_message.sent";
}

pub mod tool {
    pub const COMPLETED: &str = "tool.completed";
    pub const ERROR: &str = "tool.error";
    pub const EXECUTE: &str = "tool.execute";
    pub const LIST: &str = "tool.list";
    pub const REGISTERED: &str = "tool.registered";
    pub const REGISTRY_CHANGED: &str = "tool.registryChanged";
    pub const STARTED: &str = "tool.started";
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
        subject: "sendMessage",
        full_subject: session::SEND_MESSAGE,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartedPayload {
    pub agent_id: String,
    pub adapter_id: String,
    pub adapter_name: String,
    pub adapter_session_id: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
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

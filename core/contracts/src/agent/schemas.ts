import type { SchemaRecord } from '@makaio/core';

// Import individual schemas for composition
import {
  UserMessageSentSchema,
  UserMessageAcknowledgedSchema,
  UserMessageCompletedSchema,
  StartedSchema,
  ModelChangedSchema,
  CompleteSchema,
  IdleSchema,
  SessionClosedSchema,
  ReasoningDeltaSchema,
  ReasoningSchema,
  MessageDeltaSchema,
  MessageSchema,
  ToolUseSchema,
  ToolStartedSchema,
  ToolOutputSchema,
  ToolCompletedSchema,
  UsageSchema,
  TurnStartedSchema,
  TurnCompletedSchema,
  ContextWindowUpdatedSchema,
  SendMessageSchema,
  AgentInterruptSchema,
  AgentToolApproveSchema,
  AgentGetCapabilitiesSchema,
  StepStartedSchema,
  StepFinishedSchema,
  CwdChangeSchema,
  CwdChangedSchema,
  ModelChangeSchema,
  McpServersSetSchema,
  CredentialChangeSchema,
  ValidateModelChangeSchema,
  StructuredOutputRetryPolicySchema,
  StructuredOutputEnforceSchema,
} from './schemas/index.js';

/**
 * Agent domain schemas.
 *
 * Subjects for agent-related bus communication.
 * Each key becomes a subject identifier as: `agent.{key}`
 *
 * **Dotted keys become nested properties:**
 * Schema keys with dots (e.g., `'tool.use'`) are transformed into nested
 * subject accessors. Use dot notation to access them:
 * @example
 * ```typescript
 * // Schema key: 'tool.use' → Access as: AgentSubjects.tool.use
 * bus.emit(AgentSubjects.tool.use, { toolName: 'read', ... });
 *
 * // Schema key: 'user_message.sent' → Access as: AgentSubjects.user_message.sent
 * bus.on(AgentSubjects.user_message.sent, (ctx) => { ... });
 *
 * // Schema key: 'session.closed' → Access as: AgentSubjects.session.closed
 * bus.on(AgentSubjects.session.closed, (ctx) => { ... });
 *
 * // Non-dotted keys remain flat
 * bus.emit(AgentSubjects.started, { model: 'claude-3' });
 * bus.emit(AgentSubjects.complete, { messageId: '...' });
 * ```
 */
export const AgentSchemas = {
  'user_message.sent': UserMessageSentSchema,
  'user_message.acknowledged': UserMessageAcknowledgedSchema,
  'user_message.completed': UserMessageCompletedSchema,
  started: StartedSchema,
  'model.changed': ModelChangedSchema,
  'model.change': ModelChangeSchema,
  'mcp.servers.set': McpServersSetSchema,
  'credential.change': CredentialChangeSchema,
  complete: CompleteSchema,
  idle: IdleSchema,
  'session.closed': SessionClosedSchema,
  'cwd.changed': CwdChangedSchema,
  'cwd.change': CwdChangeSchema,
  reasoning_delta: ReasoningDeltaSchema,
  reasoning: ReasoningSchema,
  message_delta: MessageDeltaSchema,
  message: MessageSchema,
  'tool.use': ToolUseSchema,
  'tool.started': ToolStartedSchema,
  'tool.output': ToolOutputSchema,
  'tool.completed': ToolCompletedSchema,
  usage: UsageSchema,
  'turn.started': TurnStartedSchema,
  'turn.completed': TurnCompletedSchema,
  'contextWindow.updated': ContextWindowUpdatedSchema,
  'step.started': StepStartedSchema,
  'step.finished': StepFinishedSchema,
  sendMessage: SendMessageSchema,
  interrupt: AgentInterruptSchema,
  toolApprove: AgentToolApproveSchema,
  getCapabilities: AgentGetCapabilitiesSchema,
  validateModelChange: ValidateModelChangeSchema,
  'structuredOutput.retryPolicy': StructuredOutputRetryPolicySchema,
  'structuredOutput.enforce': StructuredOutputEnforceSchema,
} satisfies SchemaRecord;

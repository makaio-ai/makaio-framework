import type { ScopedBusFor } from '@makaio/bus-core';
import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import type { SessionEvent } from '@github/copilot-sdk';
import { z } from 'zod';
import { TurnStateChangedSchema } from './schemas/turn-state.js';

// Re-export turn state schemas
export { CopilotTurnStateSchema, TurnStateChangedSchema } from './schemas/turn-state.js';
export type { CopilotTurnState, TurnStateChanged } from './schemas/turn-state.js';

const namespace = 'adapter:github-copilot' as const;

/**
 * SDK bundles Zod v3, we use v4. Since skipBusValidation is enabled,
 * we use z.custom() with SDK types for compile-time safety only.
 * No runtime validation - the SDK handles that.
 * @returns Zod schema that passes all values with the given type
 */
const sdkEvent = <T>() => z.custom<T>(() => true);

/**
 * Re-export SDK's SessionEvent as CopilotSessionEvent for internal use.
 * The SDK exports a single union type; we use SessionEventOf\<\> for specific event types.
 */
export type CopilotSessionEvent = SessionEvent;

/**
 * Helper type to extract specific event types from SessionEvent union.
 * Reduces boilerplate: `SessionEventOf<'assistant.message'>` instead of `Extract<SessionEvent, { type: 'assistant.message' }>`.
 */
export type SessionEventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;

// Type aliases for specific event types
type SessionStartEvent = SessionEventOf<'session.start'>;
type SessionResumeEvent = SessionEventOf<'session.resume'>;
type SessionErrorEvent = SessionEventOf<'session.error'>;
type SessionIdleEvent = SessionEventOf<'session.idle'>;
type SessionInfoEvent = SessionEventOf<'session.info'>;
type SessionModelChangeEvent = SessionEventOf<'session.model_change'>;
type SessionTruncationEvent = SessionEventOf<'session.truncation'>;
export type SessionUsageInfoEvent = SessionEventOf<'session.usage_info'>;
type UserMessageEvent = SessionEventOf<'user.message'>;
type AssistantTurnStartEvent = SessionEventOf<'assistant.turn_start'>;
export type AssistantMessageEvent = SessionEventOf<'assistant.message'>;
type AssistantTurnEndEvent = SessionEventOf<'assistant.turn_end'>;
export type AssistantUsageEvent = SessionEventOf<'assistant.usage'>;
export type AssistantReasoningEvent = SessionEventOf<'assistant.reasoning'>;
type AssistantReasoningDeltaEvent = SessionEventOf<'assistant.reasoning_delta'>;
type AbortEvent = SessionEventOf<'abort'>;
type ToolUserRequestedEvent = SessionEventOf<'tool.user_requested'>;
type ToolExecutionStartEvent = SessionEventOf<'tool.execution_start'>;
type ToolExecutionPartialResultEvent = SessionEventOf<'tool.execution_partial_result'>;
type ToolExecutionCompleteEvent = SessionEventOf<'tool.execution_complete'>;
type HookStartEvent = SessionEventOf<'hook.start'>;
type HookEndEvent = SessionEventOf<'hook.end'>;
type SystemMessageEvent = SessionEventOf<'system.message'>;

/**
 * Extended session event with context fields added by our connector.
 */
type ExtendedSessionEvent = CopilotSessionEvent & {
  lastAssistantMessageContent?: string;
};
const ExtendedSessionEventSchema = sdkEvent<ExtendedSessionEvent>();

/**
 * GitHub Copilot Adapter Namespace (single bus).
 *
 * Contains both raw SDK events (sdk.event) and semantic subjects.
 * The connector emits to both, agent subscribes to semantic subjects.
 *
 * NOTE: skipBusValidation is enabled because \@github/copilot-sdk bundles Zod v3
 * internally, which is incompatible with our Zod v4. The intersection schemas
 * fail validation with "_parseSync is not a function" errors.
 */
export const GitHubCopilotConnectorNamespace = createAdapterNamespace(
  namespace,
  {
    // Raw SDK event catch-all (for observability/debugging)
    'sdk.event': ExtendedSessionEventSchema,
    // Tool approval RPC
    can_use_tool: ScopedToolApprovalSchema,

    // Semantic subjects (typed events for agent layer)
    'session.start': sdkEvent<SessionStartEvent>(),
    'session.resume': sdkEvent<SessionResumeEvent>(),
    'session.error': sdkEvent<SessionErrorEvent>(),
    'session.idle': sdkEvent<SessionIdleEvent>(),
    'session.info': sdkEvent<SessionInfoEvent>(),
    'session.model_change': sdkEvent<SessionModelChangeEvent>(),
    'user.message': sdkEvent<UserMessageEvent>(),
    'assistant.turn_start': sdkEvent<AssistantTurnStartEvent>(),
    'assistant.message': sdkEvent<AssistantMessageEvent>(),
    'assistant.reasoning': sdkEvent<AssistantReasoningEvent>(),
    'assistant.reasoning_delta': sdkEvent<AssistantReasoningDeltaEvent>(),
    'assistant.turn_end': sdkEvent<AssistantTurnEndEvent>(),
    'assistant.usage': sdkEvent<AssistantUsageEvent>(),
    'session.truncation': sdkEvent<SessionTruncationEvent>(),
    'session.usage_info': sdkEvent<SessionUsageInfoEvent>(),
    abort: sdkEvent<AbortEvent>(),
    'tool.user_requested': sdkEvent<ToolUserRequestedEvent>(),
    'tool.execution_start': sdkEvent<ToolExecutionStartEvent>(),
    'tool.execution_partial_result': sdkEvent<ToolExecutionPartialResultEvent>(),
    'tool.execution_complete': sdkEvent<ToolExecutionCompleteEvent>(),
    'hook.start': sdkEvent<HookStartEvent>(),
    'hook.end': sdkEvent<HookEndEvent>(),
    'system.message': sdkEvent<SystemMessageEvent>(),

    // Turn lifecycle events
    'turn.state_changed': TurnStateChangedSchema,
    'turn.turn_started': TurnStateChangedSchema,
    'turn.step_started': TurnStateChangedSchema,
    'turn.step_finished': TurnStateChangedSchema,
    'turn.turn_finished': TurnStateChangedSchema,
  },
  { skipBusValidation: true },
);

export const GitHubCopilotConnectorSubjects = GitHubCopilotConnectorNamespace.subjects;
export type GitHubCopilotConnectorBus = ScopedBusFor<typeof GitHubCopilotConnectorNamespace>;

export type GitHubCopilotSdkSessionEvent = ExtendedSessionEvent;

/**
 * Pure functions to normalize GitHub Copilot SDK events to AgentSubjects.
 *
 * Two normalizer categories:
 * - **Live-matching**: Match GitHubCopilotAgent.wireXxxEvents behavior
 * - **Import-only**: Add events for session reconstruction
 *
 * ## Type Safety Note
 * The SDK uses Zod 3 internally while this project uses Zod 4, creating type incompatibility.
 * We define event data interfaces with index signatures to enable type assertions without
 * double-casts. This is safe because we switch on `record.type` first,
 * event shapes are stable in SDK, and runtime validation happens at JSONL parsing layer.
 * @packageDocumentation
 */

import type { NormalizedEvent, ImportMetadata } from '@makaio/ai-adapters-core';
import { AgentSubjects, type StartMode } from '@makaio/contracts';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default tool name when resolution fails */
const UNKNOWN_TOOL_NAME = 'unknown';

/** Default model name when not provided */
const UNKNOWN_MODEL = 'unknown';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/** Context needed for event normalization */
export interface NormalizationContext {
  adapterId: string;
  adapterName: string;
  agentId: string;
  adapterSessionId: string;
  messageId?: string;
  timestamp?: string;
  _import?: ImportMetadata;
  /** Current turn ID propagated from assistant.turn_start events */
  turnId?: string;
}

/** Callback to resolve toolName from toolCallId (for tool.execution_complete) */
export type ToolNameResolver = (toolCallId: string) => string | undefined;

/**
 * Start modes representable by a Copilot `assistant.turn_start` event.
 *
 * Copilot logs carry no fork concept and `session.resume` records are
 * skipped, so a turn start can only mean a brand-new session (`fresh`,
 * first turn start in the stream) or a subsequent turn within the same
 * logical session (`rotation`).
 */
export type TurnStartMode = Extract<StartMode, 'fresh' | 'rotation'>;

/**
 * Raw GitHub Copilot log record structure (wrapper around SDK events).
 *
 * This interface mirrors the SDK's SessionEvent structure but with `Record<string, unknown>`
 * for data to avoid Zod version incompatibility issues. Type narrowing happens via
 * explicit `as` casts in the dispatcher after switch-case discrimination on `type`.
 *
 * Named "Raw" to distinguish from the more specific Zod-inferred GitHubCopilotLogRecord
 * in log-importer/types.ts which uses a discriminated union.
 */
export interface RawGitHubCopilotLogRecord {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}

/** Options for normalizing log records */
export interface NormalizeOptions {
  model?: string | null;
  cwd?: string | null;
  toolNameResolver?: ToolNameResolver;
  accumulatedMessage?: string;
  /**
   * Whether the current record is the first `assistant.turn_start` in the
   * stream. Callers iterating a log MUST set this to `true` for the first
   * turn start so it is labeled `startMode: 'fresh'` (`session.start`
   * records are skipped, so this turn start represents the session start).
   * Subsequent turn starts are labeled `'rotation'` (the default).
   */
  isFirstTurnStart?: boolean;
}

// =============================================================================
// EVENT DATA TYPES - SDK event payloads with index signature for Zod 3/4 compat
// =============================================================================

/** Base interface with index signature for SDK event data compatibility */
interface EventDataBase {
  [key: string]: unknown;
}

interface AssistantTurnStartData extends EventDataBase {
  turnId?: string;
}
interface AssistantMessageData extends EventDataBase {
  messageId: string;
  content: string;
}
interface ToolUserRequestedData extends EventDataBase {
  toolName: string;
  toolCallId: string;
  arguments?: unknown;
}
interface ToolExecutionStartData extends EventDataBase {
  toolName: string;
  toolCallId: string;
  arguments?: unknown;
}
interface ToolExecutionPartialResultData extends EventDataBase {
  toolCallId: string;
  partialOutput: string;
}
interface ToolExecutionCompleteData extends EventDataBase {
  toolCallId: string;
  result: unknown;
  success: boolean;
}
interface SessionTruncationData extends EventDataBase {
  postTruncationTokensInMessages: number;
  tokenLimit: number;
}
interface SessionErrorData extends EventDataBase {
  message: string;
}
interface UserMessageData extends EventDataBase {
  content: string;
}
interface AssistantTurnEndData extends EventDataBase {
  turnId?: string;
}

/**
 * Normalize raw arguments to Record\<string, unknown\>.
 * @param rawArgs - The raw arguments to normalize
 * @returns Normalized arguments object
 */
function normalizeArgs(rawArgs: unknown): Record<string, unknown> {
  return rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : { value: rawArgs };
}

// =============================================================================
// LIVE-MATCHING NORMALIZERS
// These match the behavior in GitHubCopilotAgent.wireXxxEvents
// =============================================================================

/**
 * Normalize assistant.turn_start event to agent.started.
 * @param _data - The turn start event data (unused, present for signature consistency)
 * @param ctx - Normalization context with session/adapter info
 * @param startMode - Why this start happened: `'fresh'` for the first turn
 * start in the stream (represents the session start), `'rotation'` for
 * subsequent turn starts within the same logical session
 * @param model - Model name to include in started payload
 * @param cwd - Working directory to include in started payload
 * @returns Normalized event for agent.started subject
 */
export function normalizeAssistantTurnStart(
  _data: AssistantTurnStartData,
  ctx: NormalizationContext,
  startMode: TurnStartMode,
  model?: string | null,
  cwd?: string | null,
): NormalizedEvent {
  return {
    subject: AgentSubjects.started,
    payload: { ...ctx, model: model ?? null, cwd: cwd ?? null, startMode },
  };
}

/**
 * Normalize assistant.message event to agent.message.
 * @param data - The assistant message event data
 * @param ctx - Normalization context with session/adapter info
 * @returns Array of normalized events (empty if no content)
 */
export function normalizeAssistantMessage(data: AssistantMessageData, ctx: NormalizationContext): NormalizedEvent[] {
  if (!data.content) return [];
  return [{ subject: AgentSubjects.message, payload: { ...ctx, content: data.content } }];
}

/**
 * Normalize tool.user_requested event to agent.tool.use.
 * @param data - The tool user requested event data
 * @param ctx - Normalization context with session/adapter info
 * @returns Normalized event for agent.tool.use subject
 */
export function normalizeToolUserRequested(data: ToolUserRequestedData, ctx: NormalizationContext): NormalizedEvent {
  return {
    subject: AgentSubjects.tool.use,
    payload: { ...ctx, toolName: data.toolName, toolCallId: data.toolCallId, args: normalizeArgs(data.arguments) },
  };
}

/**
 * Normalize tool.execution_start to agent.tool.use + agent.tool.started.
 * GitHub Copilot SDK logs don't emit `tool.user_requested`, so we derive `tool.use` here.
 * @param data - The tool execution start event data
 * @param ctx - Normalization context with session/adapter info
 * @returns Array of normalized events: [tool.use, tool.started]
 */
export function normalizeToolExecutionStart(
  data: ToolExecutionStartData,
  ctx: NormalizationContext,
): NormalizedEvent[] {
  const args = normalizeArgs(data.arguments);
  const basePayload = { ...ctx, toolName: data.toolName, toolCallId: data.toolCallId, args };
  return [
    { subject: AgentSubjects.tool.use, payload: basePayload },
    { subject: AgentSubjects.tool.started, payload: basePayload },
  ];
}

/**
 * Normalize tool.execution_partial_result event to agent.tool.output.
 * @param data - The tool execution partial result event data
 * @param ctx - Normalization context with session/adapter info
 * @returns Normalized event for agent.tool.output subject
 */
export function normalizeToolExecutionPartialResult(
  data: ToolExecutionPartialResultData,
  ctx: NormalizationContext,
): NormalizedEvent {
  return {
    subject: AgentSubjects.tool.output,
    payload: { ...ctx, output: data.partialOutput, toolCallId: data.toolCallId },
  };
}

/**
 * Normalize tool.execution_complete event to agent.tool.completed.
 * @param data - The tool execution complete event data
 * @param ctx - Normalization context with session/adapter info
 * @param toolName - Resolved tool name from cache/prior events
 * @returns Normalized event for agent.tool.completed subject
 */
export function normalizeToolExecutionComplete(
  data: ToolExecutionCompleteData,
  ctx: NormalizationContext,
  toolName?: string,
): NormalizedEvent {
  return {
    subject: AgentSubjects.tool.completed,
    payload: {
      ...ctx,
      toolCallId: data.toolCallId,
      toolName: toolName ?? UNKNOWN_TOOL_NAME,
      result: data.result,
      success: data.success,
    },
  };
}

/**
 * Normalize session.truncation event to agent.usage + agent.contextWindow.updated.
 * @param data - The session truncation event data
 * @param ctx - Normalization context with session/adapter info
 * @param model - Model name to include in usage payload
 * @returns Array of two events: usage and context window update
 */
export function normalizeSessionTruncation(
  data: SessionTruncationData,
  ctx: NormalizationContext,
  model?: string | null,
): NormalizedEvent[] {
  const totalTokens = data.postTruncationTokensInMessages;
  return [
    {
      subject: AgentSubjects.usage,
      payload: {
        ...ctx,
        provider: 'copilot',
        granularity: 'turn-aggregate',
        model: model ?? UNKNOWN_MODEL,
        inputTokens: totalTokens,
        inputCachedTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens,
        costUnits: 1,
        costUnitType: 'requests',
      },
    },
    {
      subject: AgentSubjects.contextWindow.updated,
      payload: { ...ctx, currentTokens: totalTokens, maxTokens: data.tokenLimit },
    },
  ];
}

/**
 * Normalize session.error event to agent.complete with error outcome.
 * @param data - The session error event data
 * @param ctx - Normalization context with session/adapter info
 * @returns Normalized event for agent.complete subject with outcome 'error'
 */
export function normalizeSessionError(data: SessionErrorData, ctx: NormalizationContext): NormalizedEvent {
  // Some imported logs don't carry a messageId; derive a stable non-empty fallback for schema-required events.
  const fallbackMessageId = `${ctx.adapterSessionId}-session-error`;
  return {
    subject: AgentSubjects.complete,
    payload: { ...ctx, messageId: ctx.messageId ?? fallbackMessageId, outcome: 'error', error: data.message },
  };
}

// =============================================================================
// IMPORT-ONLY NORMALIZERS
// These add events for session reconstruction (not emitted by live agent)
// =============================================================================

/**
 * Normalize user.message event to agent.user_message.sent + agent.turn.started.
 * @param data - The user message event data
 * @param ctx - Normalization context with session/adapter info
 * @returns Array of user_message.sent and turn.started events
 */
export function normalizeUserMessage(data: UserMessageData, ctx: NormalizationContext): NormalizedEvent[] {
  const userContent = { role: 'user' as const, blocks: [{ type: 'text' as const, content: data.content }] };
  return [
    { subject: AgentSubjects.user_message.sent, payload: { ...ctx, content: userContent, deliveryMode: 'enqueue' } },
    { subject: AgentSubjects.turn.started, payload: { ...ctx, content: userContent } },
  ];
}

/**
 * Normalize assistant.turn_end event to agent.turn.completed + agent.complete.
 *
 * Only emits events when there's accumulated message content. Tool-only turns
 * (where accumulatedMessage is empty) are intermediate steps and don't represent
 * user-visible turn completions. This matches Gemini's semantic model where
 * turn completion requires actual content.
 * @param _data - The turn end event data (unused, present for signature consistency)
 * @param ctx - Normalization context with session/adapter info
 * @param accumulatedMessage - Accumulated message text from the turn
 * @returns Array of turn.completed and complete events, or empty if no content
 */
export function normalizeAssistantTurnEnd(
  _data: AssistantTurnEndData,
  ctx: NormalizationContext,
  accumulatedMessage?: string,
): NormalizedEvent[] {
  // Skip turn completion for tool-only turns (no accumulated message content)
  if (!accumulatedMessage) {
    return [];
  }

  const payload = { ...ctx, message: accumulatedMessage, outcome: 'completed' as const };
  return [
    { subject: AgentSubjects.turn.completed, payload },
    { subject: AgentSubjects.complete, payload },
  ];
}

// =============================================================================
// MAIN DISPATCHER
// =============================================================================

/** Event types that are skipped during normalization */
const SKIPPED_EVENT_TYPES = new Set([
  'session.start',
  'session.resume',
  'session.info',
  'session.idle',
  'abort',
  'hook.start',
  'hook.end',
  'system.message',
]);

/**
 * Normalize a GitHub Copilot log record to NormalizedEvent(s).
 *
 * Type assertions (`as`) are used here because the SDK's SessionEvent type uses
 * Zod 3 which is incompatible with our Zod 4. The assertions are safe because:
 * 1. We switch on `record.type` first, ensuring we're in the correct case
 * 2. The event shapes are stable and well-documented in the SDK
 * 3. Runtime validation happens at the JSONL parsing layer
 * @param record - The log record from JSONL file
 * @param ctx - Normalization context with session/adapter info
 * @param options - Additional options for normalization
 * @returns Array of normalized events (may be empty for unhandled types)
 */
export function normalizeGitHubCopilotLogRecord(
  record: RawGitHubCopilotLogRecord,
  ctx: NormalizationContext,
  options?: NormalizeOptions,
): NormalizedEvent[] {
  const { model, cwd, toolNameResolver, accumulatedMessage, isFirstTurnStart } = options ?? {};

  // Skip known lifecycle/metadata events
  if (SKIPPED_EVENT_TYPES.has(record.type)) return [];

  // Dispatch to specific normalizers
  // Type assertions are safe here - see JSDoc above for rationale
  switch (record.type) {
    case 'assistant.turn_start':
      return [
        normalizeAssistantTurnStart(
          record.data as AssistantTurnStartData,
          ctx,
          isFirstTurnStart ? 'fresh' : 'rotation',
          model,
          cwd,
        ),
      ];
    case 'assistant.message':
      return normalizeAssistantMessage(record.data as AssistantMessageData, ctx);
    case 'tool.user_requested':
      return [normalizeToolUserRequested(record.data as ToolUserRequestedData, ctx)];
    case 'tool.execution_start':
      return normalizeToolExecutionStart(record.data as ToolExecutionStartData, ctx);
    case 'tool.execution_partial_result':
      return [normalizeToolExecutionPartialResult(record.data as ToolExecutionPartialResultData, ctx)];
    case 'tool.execution_complete': {
      const data = record.data as ToolExecutionCompleteData;
      return [normalizeToolExecutionComplete(data, ctx, toolNameResolver?.(data.toolCallId))];
    }
    case 'session.truncation':
      return normalizeSessionTruncation(record.data as SessionTruncationData, ctx, model);
    case 'session.error':
      return [normalizeSessionError(record.data as SessionErrorData, ctx)];
    case 'user.message':
      return normalizeUserMessage(record.data as UserMessageData, ctx);
    case 'assistant.turn_end':
      return normalizeAssistantTurnEnd(record.data as AssistantTurnEndData, ctx, accumulatedMessage);
    default:
      return [];
  }
}

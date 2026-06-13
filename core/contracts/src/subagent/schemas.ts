import { z } from 'zod';
import { ResponseSchemaDescriptorSchema } from '../shared/index.js';
import { ProviderContextSchema } from '../adapter/schemas/provider-context.js';
import { AIReasoningLevelSchema } from '../model/index.js';

// ============================================================================
// Configuration Schemas
// ============================================================================

/**
 * Context mode for subagent spawning.
 * - fork: Inherit parent's conversation history
 * - fresh: Start with clean context
 */
export const ContextModeSchema = z.enum(['fork', 'fresh']);
export type ContextMode = z.infer<typeof ContextModeSchema>;

/**
 * Subagent status enum.
 * - spawning: Session creation in progress (set by spawn tool)
 * - running: Session created, agent executing (set by SubagentService)
 * - waiting_input: Blocked on request_input
 * - hung: No activity within inactivity timeout (non-terminal; coordinator decides action)
 * - completed/failed/cancelled: Terminal states
 */
export const SubagentStatusSchema = z.enum([
  'spawning',
  'running',
  'waiting_input',
  'hung',
  'completed',
  'failed',
  'cancelled',
]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/**
 * Completion mode for a spawned subagent.
 *
 * - `'tool'` — the child must call `completeTask` to terminate (default, existing semantics).
 * - `'turn'` — the first completed agent turn terminalizes the subagent with the final
 *   assistant message as its result. Use this for single-shot subagents that produce prose
 *   or structured output without needing to call a completion tool.
 *
 * Conceptual note: subagents are conversations, not one-shot calls — the parent can send
 * follow-ups and the child can ask questions. "The agent stopped talking" does not generally
 * mean "the task is done", which is why `'tool'` is the default. Declare `'turn'` only when
 * the subagent's first response IS the result.
 */
export const CompletionModeSchema = z.enum(['tool', 'turn']);
export type CompletionMode = z.infer<typeof CompletionModeSchema>;

/**
 * Configuration for spawning a subagent.
 */
export const SubagentConfigSchema = z.object({
  /** Task description for the subagent */
  task: z.string(),
  /** Adapter driver name (default: inherit from parent) */
  adapterName: z.string().optional(),
  /** Provider configuration identifier */
  providerConfigId: z.string().optional(),
  /**
   * Resolved provider context for callers that already performed provider selection.
   *
   * Prefer `providerConfigId` for persisted/user-authored subagent configs. Workflow
   * role resolution may supply a fully resolved context so isolated and in-process
   * workflow steps route credentials through the same adapter contract.
   */
  providerContext: ProviderContextSchema.optional(),
  /** Harness ID for tool/runtime configuration. Inherits from parent if omitted. */
  harnessId: z.string().optional(),
  /** Model identifier (default: inherit from parent) */
  model: z.string().optional(),
  /** Reasoning effort level to apply for supporting adapters. */
  reasoningEffort: AIReasoningLevelSchema.optional(),
  /** Context mode: fork (inherit history) or fresh (clean) */
  contextMode: ContextModeSchema.default('fork'),
  /** Tool allowlist (default: inherit from parent) */
  tools: z.array(z.string()).optional(),
  /** Additional tools to block */
  disallowedTools: z.array(z.string()).optional(),
  /** Directory allowlist forwarded to adapters that enforce filesystem boundaries. */
  allowedDirectories: z.array(z.string()).optional(),
  /** Additional system prompt instructions */
  systemPrompt: z.string().optional(),
  /** Max nesting depth (capped by runtime constraint) */
  maxDepth: z.number().optional(),
  /**
   * Structured output descriptor.
   * When present, the executor requests structured output from the adapter.
   */
  responseSchema: ResponseSchemaDescriptorSchema.optional(),
  /** Execution target override. Resolved via ExecutionTargetSubjects.resolve if omitted. */
  executionTargetId: z.string().optional(),
  /**
   * Completion mode for this subagent. Defaults to `'tool'` when omitted.
   *
   * - `'tool'` — child must call `completeTask` (default, existing semantics).
   * - `'turn'` — the first completed agent turn terminalizes the subagent; use for
   *   single-shot agents without tools that produce their result in one response.
   *
   * Kept `.optional()` rather than `.default()` so the inferred config type does
   * not force every construction site to spell out the default; readers apply
   * `config.completion ?? 'tool'`.
   */
  completion: CompletionModeSchema.optional(),
});
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

// ============================================================================
// Runtime Constraints (set by platform, not spawning agent)
// ============================================================================

/**
 * Platform-level constraints for subagent spawning.
 */
export const SubagentConstraintsSchema = z.object({
  /** Max nesting depth (default: 3) */
  maxDepth: z.number().default(3),
  /** Max concurrent subagents per parent session */
  maxConcurrentPerSession: z.number().default(10),
  /** Max total active subagents across all sessions */
  maxTotalActive: z.number().default(50),
  /** Default timeout for request_input (ms) */
  defaultRequestTimeoutMs: z.number().default(60_000),
  /** Default timeout for await_subagent (ms) */
  defaultAwaitTimeoutMs: z.number().default(300_000),
  /** TTL for completed subagent state (ms) */
  stateRetentionMs: z.number().default(30 * 60 * 1000),
  /**
   * Inactivity timeout for hung subagent detection (ms).
   * 0 = disabled (default). Set to e.g. 300_000 (5 min) to enable.
   * A subagent is considered hung when no state mutation occurs within this window.
   */
  inactivityTimeoutMs: z.number().int().nonnegative().default(0),
  /**
   * How often to run the periodic maintenance interval (ms).
   * Controls both hung-subagent sweep (when inactivityTimeoutMs \> 0) and
   * completed-state cleanup (stateRetentionMs TTL). 0 = no periodic maintenance.
   * Default: 60_000 (1 min).
   */
  sweepIntervalMs: z.number().int().nonnegative().default(60_000),
  /** Adapters allowed for subagents (empty = all) */
  allowedAdapters: z.array(z.string()).default([]),
  /** Models allowed for subagents (empty = all) */
  allowedModels: z.array(z.string()).default([]),
});
export type SubagentConstraints = z.infer<typeof SubagentConstraintsSchema>;

/**
 * Default runtime constraints (derived from schema defaults to avoid duplication).
 */
export const DEFAULT_CONSTRAINTS: SubagentConstraints = SubagentConstraintsSchema.parse({});

// ============================================================================
// Usage Stats
// ============================================================================

export const UsageStatsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});
export type UsageStats = z.infer<typeof UsageStatsSchema>;

// ============================================================================
// Pending Request (for request_input tracking)
// ============================================================================

export const PendingRequestSchema = z.object({
  messageId: z.string(),
  question: z.string(),
  context: z.string().optional(),
});
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

// ============================================================================
// Execution Layer Schemas
// ============================================================================

/**
 * Request to execute a spawned subagent.
 * Used by SubagentService for explicit execution requests.
 */
export const ExecuteSubagentRequestSchema = z.object({
  subagentId: z.string(),
  parentSessionId: z.string(),
  task: z.string(),
  config: SubagentConfigSchema,
  depth: z.number(),
});
export type ExecuteSubagentRequest = z.infer<typeof ExecuteSubagentRequestSchema>;

export const ExecuteSubagentResponseSchema = z.object({
  success: z.boolean(),
  agentId: z.string().optional(),
  error: z.string().optional(),
});
export type ExecuteSubagentResponse = z.infer<typeof ExecuteSubagentResponseSchema>;

/**
 * Subagent execution failed during startup.
 */
export const SubagentExecutionFailedSchema = z.object({
  subagentId: z.string(),
  parentSessionId: z.string(),
  error: z.string(),
  phase: z.enum(['session_create', 'adapter_start', 'agent_start']),
});
export type SubagentExecutionFailed = z.infer<typeof SubagentExecutionFailedSchema>;

// ============================================================================
// RPC Schemas (for service-owned state operations)
// ============================================================================

/**
 * Spawn RPC - replaces tool calling manager.track().
 * Service validates constraints, tracks subagent, emits spawned event.
 */
export const SpawnSubagentRpcRequestSchema = z.object({
  parentSessionId: z.string(),
  config: SubagentConfigSchema,
  depth: z.number(),
  /** Tool call ID of the spawn_subagent invocation. Used to link parent tool call to child session. */
  spawningToolCallId: z.string().optional(),
});
export type SpawnSubagentRpcRequest = z.infer<typeof SpawnSubagentRpcRequestSchema>;

export const SpawnSubagentRpcResponseSchema = z.object({
  subagentId: z.string(),
  status: z.literal('spawning'),
});
export type SpawnSubagentRpcResponse = z.infer<typeof SpawnSubagentRpcResponseSchema>;

/**
 * Await RPC - replaces callback-based awaiter.
 * Blocks until subagent reaches terminal state or timeout.
 */
export const AwaitSubagentRequestSchema = z.object({
  subagentId: z.string(),
  timeoutMs: z.number().optional(),
});
export type AwaitSubagentRequest = z.infer<typeof AwaitSubagentRequestSchema>;

export const AwaitSubagentResponseSchema = z.object({
  status: z.enum(['completed', 'failed', 'waiting_input', 'timeout', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
  pendingRequest: PendingRequestSchema.optional(),
  /**
   * Which mechanism terminalized the subagent.
   * Present when `status === 'completed'`.
   * - `'tool'` — child called `completeTask`.
   * - `'turn'` — first completed agent turn was treated as the result (`completion: 'turn'` mode).
   */
  completionSource: CompletionModeSchema.optional(),
});
export type AwaitSubagentResponse = z.infer<typeof AwaitSubagentResponseSchema>;

/**
 * Send RPC - sends message to subagent, optionally resolving pending request.
 */
export const SendToSubagentRequestSchema = z.object({
  subagentId: z.string(),
  content: z.string(),
  inResponseTo: z.string().optional(),
});
export type SendToSubagentRequest = z.infer<typeof SendToSubagentRequestSchema>;

export const SendToSubagentResponseSchema = z.object({
  sent: z.boolean(),
  resolvedPending: z.boolean(),
});
export type SendToSubagentResponse = z.infer<typeof SendToSubagentResponseSchema>;

/**
 * Kill RPC - terminates a running subagent.
 */
export const KillSubagentRequestSchema = z.object({
  subagentId: z.string(),
  reason: z.string().optional(),
});
export type KillSubagentRequest = z.infer<typeof KillSubagentRequestSchema>;

export const KillSubagentResponseSchema = z.object({
  killed: z.boolean(),
});
export type KillSubagentResponse = z.infer<typeof KillSubagentResponseSchema>;

/**
 * Report Progress RPC - child reports progress update.
 */
export const ReportProgressRequestSchema = z.object({
  subagentId: z.string(),
  update: z.string(),
  percentComplete: z.number().optional(),
});
export type ReportProgressRequest = z.infer<typeof ReportProgressRequestSchema>;

export const ReportProgressResponseSchema = z.object({
  reported: z.boolean(),
});
export type ReportProgressResponse = z.infer<typeof ReportProgressResponseSchema>;

/**
 * Request Input RPC - child requests input from parent.
 * Blocks until parent responds or timeout.
 */
export const RequestInputRpcRequestSchema = z.object({
  subagentId: z.string(),
  question: z.string(),
  context: z.string().optional(),
  timeoutMs: z.number().optional(),
});
export type RequestInputRpcRequest = z.infer<typeof RequestInputRpcRequestSchema>;

export const RequestInputRpcResponseSchema = z.object({
  responded: z.boolean(),
  response: z.string().optional(),
  timedOut: z.boolean(),
});
export type RequestInputRpcResponse = z.infer<typeof RequestInputRpcResponseSchema>;

/**
 * Complete Task RPC - child signals task completion.
 */
export const CompleteTaskRequestSchema = z.object({
  subagentId: z.string(),
  result: z.string(),
  summary: z.string().optional(),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequestSchema>;

export const CompleteTaskResponseSchema = z.object({
  completed: z.boolean(),
});
export type CompleteTaskResponse = z.infer<typeof CompleteTaskResponseSchema>;

// ============================================================================
// List By Session RPC (for manifest builder)
// ============================================================================

/**
 * Condensed subagent summary returned by the listBySession RPC.
 * Contains only the fields meaningful for coordinator orientation.
 */
export const SubagentSummarySchema = z.object({
  /** Subagent identifier */
  subagentId: z.string(),
  /** Task description assigned to the subagent */
  task: z.string(),
  /** Current status */
  status: SubagentStatusSchema,
});
export type SubagentSummary = z.infer<typeof SubagentSummarySchema>;

/**
 * List subagents by parent session RPC.
 * Returns all non-terminal subagents spawned by the given parent session.
 *
 * Note: SubagentService tracks subagents in memory only. This list will be
 * empty after a process restart — subagents re-register as they report back.
 */
export const ListSubagentsBySessionRequestSchema = z.object({
  /** Parent session ID to filter subagents by */
  parentSessionId: z.string(),
});
export type ListSubagentsBySessionRequest = z.infer<typeof ListSubagentsBySessionRequestSchema>;

export const ListSubagentsBySessionResponseSchema = z.object({
  /** Non-terminal subagents for the given parent session */
  subagents: z.array(SubagentSummarySchema),
});
export type ListSubagentsBySessionResponse = z.infer<typeof ListSubagentsBySessionResponseSchema>;

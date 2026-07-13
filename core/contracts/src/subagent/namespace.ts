import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import {
  SubagentConfigSchema,
  SubagentStatusSchema,
  UsageStatsSchema,
  PendingRequestSchema,
  ExecuteSubagentRequestSchema,
  ExecuteSubagentResponseSchema,
  SubagentExecutionFailedSchema,
  // RPC schemas for service-owned state operations
  SpawnSubagentRpcRequestSchema,
  SpawnSubagentRpcResponseSchema,
  AwaitSubagentRequestSchema,
  AwaitSubagentResponseSchema,
  SendToSubagentRequestSchema,
  SendToSubagentResponseSchema,
  KillSubagentRequestSchema,
  KillSubagentResponseSchema,
  ReportProgressRequestSchema,
  ReportProgressResponseSchema,
  RequestInputRpcRequestSchema,
  RequestInputRpcResponseSchema,
  CompleteTaskRequestSchema,
  CompleteTaskResponseSchema,
  ListSubagentsBySessionRequestSchema,
  ListSubagentsBySessionResponseSchema,
} from './schemas.js';

/**
 * Subagent bus subjects for parent-child communication.
 *
 * Subjects:
 * - Lifecycle events: spawned, completed, cancelled
 * - Communication: toChild, toParent
 * - Status query: getStatus (RPC)
 */
export const SubagentSchemas = {
  // ============================================================================
  // Lifecycle Events (observable)
  // ============================================================================

  /**
   * Emitted when a subagent is spawned.
   * Subject: `subagent.spawned`
   *
   * Note: childSessionId is not included - the session is created by
   * SubagentService after receiving this event, not pre-generated.
   */
  spawned: z.object({
    subagentId: z.string(),
    parentSessionId: z.string(),
    task: z.string(),
    config: SubagentConfigSchema,
    depth: z.number(),
    /** Identifies the SubagentService instance that won the spawn RPC and owns execution. */
    executionOwnerId: z.string().optional(),
    /** Tool call ID of the spawn_subagent invocation. Forwarded to the child session as spawningToolCallId. */
    spawningToolCallId: z.string().optional(),
  }),

  /**
   * Emitted when a subagent completes (success or failure).
   * Subject: `subagent.completed`
   */
  completed: z.object({
    subagentId: z.string(),
    success: z.boolean(),
    result: z.string().optional(),
    error: z.string().optional(),
    usage: UsageStatsSchema.optional(),
  }),

  /**
   * Emitted when a subagent is cancelled by parent.
   * Subject: `subagent.cancelled`
   */
  cancelled: z.object({
    subagentId: z.string(),
    reason: z.string(),
  }),

  // ============================================================================
  // Parent -> Child Communication
  // ============================================================================

  /**
   * Message from parent to subagent.
   * Subject: `subagent.toChild`
   */
  toChild: z.object({
    subagentId: z.string(),
    messageId: z.string(),
    content: z.string(),
    /** If answering a request_input */
    inResponseTo: z.string().optional(),
  }),

  // ============================================================================
  // Child -> Parent Communication
  // ============================================================================

  /**
   * Message from subagent to parent.
   * Subject: `subagent.toParent`
   * Types: progress (status update), request_input (blocking question)
   */
  toParent: z.object({
    subagentId: z.string(),
    messageId: z.string(),
    type: z.enum(['progress', 'request_input']),
    content: z.string(),
    context: z.string().optional(),
  }),

  // ============================================================================
  // Status Query (RPC)
  // ============================================================================

  /**
   * Query subagent status.
   * Subject: `subagent.getStatus`
   */
  getStatus: {
    request: z.object({
      subagentId: z.string(),
    }),
    response: z.object({
      status: SubagentStatusSchema,
      childSessionId: z.string().optional(),
      pendingRequest: PendingRequestSchema.optional(),
      progress: z.array(z.string()),
      result: z.string().optional(),
      summary: z.string().optional(),
      error: z.string().optional(),
    }),
  },

  // ============================================================================
  // Execution Layer
  // ============================================================================

  /** RPC: Execute a spawned subagent (create session + start adapter) */
  execute: {
    request: ExecuteSubagentRequestSchema,
    response: ExecuteSubagentResponseSchema,
  },

  /** Event: Subagent execution failed during startup */
  executionFailed: SubagentExecutionFailedSchema,

  // ============================================================================
  // State Operation RPCs (tools -> service)
  // ============================================================================

  /** RPC: Spawn a subagent (validates constraints, tracks, emits spawned) */
  spawn: {
    request: SpawnSubagentRpcRequestSchema,
    response: SpawnSubagentRpcResponseSchema,
  },

  /** RPC: Await subagent completion or terminal state */
  await: {
    request: AwaitSubagentRequestSchema,
    response: AwaitSubagentResponseSchema,
  },

  /** RPC: Send message to subagent */
  send: {
    request: SendToSubagentRequestSchema,
    response: SendToSubagentResponseSchema,
  },

  /** RPC: Kill a running subagent */
  kill: {
    request: KillSubagentRequestSchema,
    response: KillSubagentResponseSchema,
  },

  /** RPC: Child reports progress */
  reportProgress: {
    request: ReportProgressRequestSchema,
    response: ReportProgressResponseSchema,
  },

  /** RPC: Child requests input from parent */
  requestInput: {
    request: RequestInputRpcRequestSchema,
    response: RequestInputRpcResponseSchema,
  },

  /** RPC: Child signals task completion */
  completeTask: {
    request: CompleteTaskRequestSchema,
    response: CompleteTaskResponseSchema,
  },

  /**
   * RPC: List non-terminal subagents for a parent session.
   * Used by the coordinator manifest builder to populate `activeSubagents`.
   * Returns an empty array after process restart (in-memory tracking only).
   */
  listBySession: {
    request: ListSubagentsBySessionRequestSchema,
    response: ListSubagentsBySessionResponseSchema,
  },
} satisfies SchemaRecord;

export const SubagentNamespace = createBusNamespace('subagent', SubagentSchemas);

export const SubagentSubjects = SubagentNamespace.subjects;

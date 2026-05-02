/**
 * Delta event handlers for Codex App-Server notifications.
 *
 * These handle streaming content updates (agent messages, command output, reasoning, file changes).
 * @packageDocumentation
 */

import { z } from 'zod';
import { CodexAppServerSubjects, type CodexAppServerBus } from '../namespaces/index.js';

/**
 * Emit function type for bus events.
 */
type EmitFn = CodexAppServerBus['emit'];

/**
 * Create a type guard validator for a Zod schema.
 * Logs validation errors when parsing fails.
 * @param schema - The Zod schema to validate against
 * @param name - Human-readable name for error logging
 * @returns A type guard function that validates and logs errors
 */
function createValidator<S extends z.ZodType>(schema: S, name: string): (params: unknown) => params is z.infer<S> {
  return (params: unknown): params is z.infer<S> => {
    const result = schema.safeParse(params);
    if (!result.success) {
      console.warn(`[delta-handlers] Invalid ${name} notification:`, result.error.format());
    }
    return result.success;
  };
}

/**
 * Schema for agent message delta notification params (incoming from JSON-RPC).
 * Validates the raw notification payload before processing.
 */
const AgentMessageDeltaNotificationSchema = z.union([
  z.object({
    threadId: z.string(),
    turnId: z.string(),
    delta: z.string(),
  }),
  z.object({
    delta: z.string(),
  }),
]);

const isValidAgentMessageDeltaNotification = createValidator(
  AgentMessageDeltaNotificationSchema,
  'agent message delta',
);

/**
 * Schema for command output delta notification params (incoming from JSON-RPC).
 * Validates the raw notification payload before processing.
 */
const CommandOutputDeltaNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});

const isValidCommandOutputDeltaNotification = createValidator(
  CommandOutputDeltaNotificationSchema,
  'command output delta',
);

/**
 * Schema for reasoning delta notification params (incoming from JSON-RPC).
 * Validates the raw notification payload before processing.
 */
const ReasoningDeltaNotificationSchema = z.union([
  z.object({
    threadId: z.string(),
    turnId: z.string(),
    delta: z.string(),
  }),
  z.object({
    delta: z.string(),
  }),
]);

const isValidReasoningDeltaNotification = createValidator(ReasoningDeltaNotificationSchema, 'reasoning delta');

/**
 * Schema for file change delta notification params (incoming from JSON-RPC).
 * Validates the raw notification payload before processing.
 */
const FileChangeDeltaNotificationSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});

const isValidFileChangeDeltaNotification = createValidator(FileChangeDeltaNotificationSchema, 'file change delta');

/**
 * Handle agent message delta notification.
 * @param emit - Bus emit function
 * @param params - Delta notification params
 * @param onAccumulate - Callback to accumulate content
 */
export async function handleAgentMessageDelta(
  emit: EmitFn,
  params: unknown,
  onAccumulate: (delta: string) => void,
): Promise<void> {
  if (!isValidAgentMessageDeltaNotification(params)) {
    console.warn('[delta-handlers] Skipping invalid agent message delta notification');
    return;
  }

  const delta = params.delta;

  // Accumulate agent message content
  onAccumulate(delta);

  if ('threadId' in params) {
    await emit(CodexAppServerSubjects.agent_message_delta, {
      threadId: params.threadId,
      turnId: params.turnId,
      delta: params.delta,
      timestamp: Date.now(),
    });
  } else {
    console.warn(
      '[CodexAppServerConnector] Agent message delta received without threadId, accumulating but not emitting',
    );
  }
}

/**
 * Handle command output delta notification.
 * @param emit - Bus emit function
 * @param params - Delta notification params
 */
export async function handleCommandOutputDelta(emit: EmitFn, params: unknown): Promise<void> {
  if (!isValidCommandOutputDeltaNotification(params)) {
    console.warn('[delta-handlers] Skipping invalid command output delta notification');
    return;
  }

  await emit(CodexAppServerSubjects.exec_command_output_delta, {
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.itemId,
    stream: 'stdout',
    chunk: params.delta,
    timestamp: Date.now(),
  });
}

/**
 * Handle reasoning delta notification.
 * @param emit - Bus emit function
 * @param params - Delta notification params
 */
export async function handleReasoningDelta(emit: EmitFn, params: unknown): Promise<void> {
  if (!isValidReasoningDeltaNotification(params)) {
    console.warn('[delta-handlers] Skipping invalid reasoning delta notification');
    return;
  }

  if ('threadId' in params) {
    await emit(CodexAppServerSubjects.reasoning_delta, {
      threadId: params.threadId,
      turnId: params.turnId,
      delta: params.delta,
      timestamp: Date.now(),
    });
  }
}

/**
 * Handle file change delta notification.
 * @param emit - Bus emit function
 * @param params - Delta notification params
 */
export async function handleFileChangeDelta(emit: EmitFn, params: unknown): Promise<void> {
  if (!isValidFileChangeDeltaNotification(params)) {
    console.warn('[delta-handlers] Skipping invalid file change delta notification');
    return;
  }

  await emit(CodexAppServerSubjects.file_change_output_delta, {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    delta: params.delta,
    timestamp: Date.now(),
  });
}

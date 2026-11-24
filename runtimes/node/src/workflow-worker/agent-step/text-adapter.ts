import { randomUUID } from 'node:crypto';
import type { JsonSchema } from '@makaio/contracts';
import {
  AgentModelReplySchema,
  ModelFailureSchema,
  AgentStepStartSchema,
  prepareAgentModelRequest,
  type AgentStepAdapter,
  type AgentStepExecution,
  type AgentStepTurnResult,
} from './protocol.js';

/**
 * Decode the reply without passing model text into diagnostic output.
 * @param body - Parsed HTTP response body.
 * @param outputSchema - Declared output schema for the turn.
 * @returns Structured output, usage, or a fixed failure.
 */
async function readTurnResult(body: unknown, outputSchema: JsonSchema): Promise<AgentStepTurnResult> {
  const reply = AgentModelReplySchema.safeParse(body);
  if (!reply.success) return { kind: 'failed', reason: 'reply-invalid' };
  const decoder = (await import('@makaio/subsystem-workflow-engine/workflow-orchestrator').catch(() => undefined))
    ?.decodeAgentStepOutput;
  if (decoder === undefined) return { kind: 'failed', reason: 'process-failed' };
  try {
    const output = decoder(reply.data.text, outputSchema);
    if (output === undefined) return { kind: 'failed', reason: 'output-invalid' };
    const { usage } = reply.data;
    return { kind: 'completed', result: { output, ...(usage === undefined ? {} : { usage }) } };
  } catch {
    return { kind: 'failed', reason: 'output-invalid' };
  }
}

/**
 * Run one model turn using only the scoped address supplied by the worker.
 * @param address - Mediator address for this step.
 * @param requestBody - Serialized text turn within the wire budget.
 * @param outputSchema - Declared output schema for the turn.
 * @param signal - Step cancellation.
 * @returns A typed turn outcome with content-free transport errors.
 */
async function complete(
  address: string,
  requestBody: string,
  outputSchema: JsonSchema,
  signal: AbortSignal,
): Promise<AgentStepTurnResult> {
  try {
    const response = await fetch(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      const failure = ModelFailureSchema.safeParse(await response.json());
      return { kind: 'failed', reason: failure.success ? failure.data.code : 'model-unreachable' };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (signal.aborted) return { kind: 'cancelled' };
    const turn = await readTurnResult(body, outputSchema);
    return signal.aborted ? { kind: 'cancelled' } : turn;
  } catch {
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'model-unreachable' };
  }
}

const START_FIELDS = new Set([
  'adapterId',
  'role',
  'model',
  'initialMessage',
  'responseSchema',
  'agentId',
  'sessionId',
  'ownerInstanceId',
  'mode',
]);

/**
 * Find the first option the text adapter cannot handle, before schema parsing strips it.
 * @param input - Incoming adapter input.
 * @returns Unsupported field name, if present.
 */
function unsupportedField(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('request' in input)) return undefined;
  const { request } = input;
  if (typeof request !== 'object' || request === null) return undefined;
  return Object.keys(request).find((key) => !START_FIELDS.has(key));
}

/**
 * One-turn structured-output adapter for an isolated step. Provider credentials live behind the worker's mediator.
 * @param adapterId - Identity of this adapter instance.
 * @param ownerInstanceId - Runtime incarnation that owns the adapter.
 * @returns The agent step adapter.
 */
export function createTextAgentStepAdapter(adapterId: string, ownerInstanceId: string): AgentStepAdapter {
  return {
    capabilities: {
      capabilities: ['structuredOutput'],
      nativeTools: [],
      environment: [{ name: 'MAKAIO_MODEL_ADDRESS', source: 'makaio.model-address' }],
    },
    start(input, signal): AgentStepExecution {
      const field = unsupportedField(input);
      if (field !== undefined) {
        return {
          start: {
            success: false,
            dispatch: 'not-dispatched',
            message: `Unsupported agent step start field: ${field.slice(0, 64)}`,
          },
        };
      }
      const parsed = AgentStepStartSchema.safeParse(input);
      if (signal.aborted || !parsed.success) {
        return { start: { success: false, dispatch: 'not-dispatched', message: 'Agent step start refused' } };
      }
      const { request, modelAddress } = parsed.data;
      const { initialMessage, responseSchema } = request;
      if (typeof initialMessage !== 'string' || initialMessage.length === 0 || responseSchema === undefined) {
        return {
          start: { success: false, dispatch: 'not-dispatched', message: 'Structured agent step input required' },
        };
      }
      const turn = prepareAgentModelRequest(request.model, initialMessage, responseSchema);
      if (
        (request.mode ?? 'create') !== 'create' ||
        request.adapterId !== adapterId ||
        (request.ownerInstanceId !== undefined && request.ownerInstanceId !== ownerInstanceId) ||
        turn.kind !== 'ready'
      ) {
        return {
          start: { success: false, dispatch: 'not-dispatched', message: 'Unsupported agent step start' },
          ...(turn.kind === 'too-large' && { reason: 'prompt-too-large' }),
        };
      }
      return {
        start: {
          success: true,
          adapterId,
          ownerInstanceId,
          agentId: request.agentId ?? randomUUID(),
          sessionId: request.sessionId ?? randomUUID(),
          messageId: randomUUID(),
        },
        turn: complete(modelAddress, turn.body, responseSchema.schema, signal),
      };
    },
  };
}

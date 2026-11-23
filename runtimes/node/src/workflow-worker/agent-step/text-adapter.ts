import { randomUUID } from 'node:crypto';
import {
  AgentModelReplySchema,
  ModelFailureSchema,
  AgentModelRequestSchema,
  AgentStepStartSchema,
  type AgentModelRequest,
  type AgentStepAdapter,
  type AgentStepExecution,
  type AgentStepTurnResult,
} from './protocol.js';

/**
 * Run one model turn using only the scoped address supplied by the worker.
 * @param address - Mediator address for this step.
 * @param input - Text turn.
 * @param signal - Step cancellation.
 * @returns A typed turn outcome with content-free transport errors.
 */
async function complete(address: string, input: AgentModelRequest, signal: AbortSignal): Promise<AgentStepTurnResult> {
  try {
    const response = await fetch(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      const failure = ModelFailureSchema.safeParse(await response.json());
      return { kind: 'failed', reason: failure.success ? failure.data.code : 'model-unreachable' };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (signal.aborted) return { kind: 'cancelled' };
    const reply = AgentModelReplySchema.safeParse(body);
    return reply.success ? { kind: 'completed', result: reply.data } : { kind: 'failed', reason: 'reply-invalid' };
  } catch {
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'model-unreachable' };
  }
}

const START_FIELDS = new Set([
  'adapterId',
  'role',
  'model',
  'initialMessage',
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
 * One-turn text adapter for an isolated step. Provider credentials live behind the worker's mediator.
 * @param adapterId - Identity of this adapter instance.
 * @param ownerInstanceId - Runtime incarnation that owns the adapter.
 * @returns The agent step adapter.
 */
export function createTextAgentStepAdapter(adapterId: string, ownerInstanceId: string): AgentStepAdapter {
  return {
    capabilities: {
      capabilities: [],
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
      const turn = AgentModelRequestSchema.safeParse({ model: request.model, prompt: request.initialMessage });
      if (
        (request.mode ?? 'create') !== 'create' ||
        request.adapterId !== adapterId ||
        (request.ownerInstanceId !== undefined && request.ownerInstanceId !== ownerInstanceId) ||
        !turn.success
      ) {
        return { start: { success: false, dispatch: 'not-dispatched', message: 'Unsupported agent step start' } };
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
        turn: complete(modelAddress, turn.data, signal),
      };
    },
  };
}

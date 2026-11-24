import { JsonValueSchema, ResponseSchemaDescriptorSchema, type ResponseSchemaDescriptor } from '@makaio/contracts';
import { AdapterSchemas, StartAgentSchema, type StartAgentResponse } from '@makaio/contracts/adapter';
import { NoAdapterAuthDeliverySchema } from '@makaio/contracts/auth';
import { z } from 'zod';

/** Byte ceiling for a model request or reply before decoding. */
export const MODEL_MESSAGE_LIMIT_BYTES = 128 * 1024;

/** Environment entries resolved by the worker before starting an agent. */
export const AgentStepCapabilitiesSchema = AdapterSchemas.getCapabilities.response
  .extend({ environment: z.array(z.strictObject({ name: z.string().min(1), source: z.string().min(1) })) })
  .strict();

/** Address leased by the worker's local model mediator for this execution. */
export const LocalModelAddressSchema = z.url().refine((address) => {
  const parsed = URL.parse(address);
  return (
    parsed !== null &&
    parsed.protocol === 'http:' &&
    parsed.hostname === '127.0.0.1' &&
    parsed.port !== '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    /^\/model\/[a-f0-9-]{36}$/.test(parsed.pathname)
  );
});

/** Agent start with a mediated model address and no credential delivery. */
export const AgentStepStartSchema = z.strictObject({
  request: StartAgentSchema.request,
  auth: NoAdapterAuthDeliverySchema,
  modelAddress: LocalModelAddressSchema,
});

/** Agent step start input. */
export type AgentStepStart = z.infer<typeof AgentStepStartSchema>;

const TextSchema = z.string().min(1);

/** Data-only launch message. The model lease is supplied through the process environment. */
export const AgentStepProcessInputSchema = z.strictObject({
  adapterId: z.string().min(1),
  ownerInstanceId: z.string().min(1),
  model: z.string().min(1).max(128),
  initialMessage: TextSchema,
  responseSchema: ResponseSchemaDescriptorSchema,
});

export type AgentStepProcessInput = z.infer<typeof AgentStepProcessInputSchema>;

/** A bounded text turn sent to the fixed model mediator. */
export const AgentModelRequestSchema = z.strictObject({
  model: z.string().min(1).max(128),
  prompt: TextSchema,
  stream: z.boolean().optional(),
});
/** Optional model usage, reserved for upstream accounting. */
const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
/** Reply fields understood by the adapter. New fields are stripped on receipt. */
export const AgentModelReplySchema = z.object({ text: TextSchema, usage: UsageSchema.optional() });
/** Stable errors returned by the mediator and surfaced in the turn. */
export const ModelFailureCodeSchema = z.enum([
  'request-invalid',
  'request-too-large',
  'model-not-in-session',
  'upstream-failed',
  'reply-invalid',
  'streaming-unsupported',
  'model-unreachable',
  'request-timed-out',
  'environmentMissing',
]);
/** Content-free failures that can be reported by an isolated agent turn. */
export const AgentStepProcessFailureSchema = ModelFailureCodeSchema.or(
  z.enum(['agent-start-refused', 'agent-turn-failed', 'process-failed', 'output-invalid', 'prompt-too-large']),
);
export type AgentStepProcessFailure = z.infer<typeof AgentStepProcessFailureSchema>;
/** A fixed diagnostic without upstream data. */
export type ModelFailureCode = z.infer<typeof ModelFailureCodeSchema>;
/** Wire error envelope used by the model endpoint. */
export const ModelFailureSchema = z.object({ code: z.string().min(1).max(128) });
/** Worker-scoped model request. */
export type AgentModelRequest = z.infer<typeof AgentModelRequestSchema>;
/** Text reply and optional usage. */
export type AgentModelReply = z.infer<typeof AgentModelReplySchema>;

/**
 * Encode one model message within the HTTP byte budget.
 * @param message - Validated model request or reply.
 * @returns Serialized message when it fits.
 */
export function serializeModelMessage(message: AgentModelRequest | AgentModelReply): string | undefined {
  const body = JSON.stringify(message);
  return Buffer.byteLength(body, 'utf8') <= MODEL_MESSAGE_LIMIT_BYTES ? body : undefined;
}

/**
 * Format the exact request sent over the model connection, including JSON framing.
 * @param model - Model selected for this session.
 * @param initialMessage - Resolved system and task prompt.
 * @param responseSchema - Required structured output schema.
 * @returns The encoded model request or a content-free refusal.
 */
export function prepareAgentModelRequest(
  model: string | undefined,
  initialMessage: string,
  responseSchema: ResponseSchemaDescriptor,
): { readonly kind: 'ready'; readonly body: string } | { readonly kind: 'invalid' | 'too-large' } {
  if (initialMessage.length === 0) return { kind: 'invalid' };
  const prompt = [
    initialMessage,
    'Return only a JSON value matching this schema. Do not include Markdown or explanatory text.',
    JSON.stringify(responseSchema.schema),
  ].join('\n\n');
  const input = AgentModelRequestSchema.safeParse({ model, prompt });
  if (!input.success) return { kind: 'invalid' };
  const body = serializeModelMessage(input.data);
  return body === undefined ? { kind: 'too-large' } : { kind: 'ready', body };
}

/** Schema for a settled turn. */
export const AgentStepTurnResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('completed'),
    result: z.strictObject({ output: JsonValueSchema, usage: UsageSchema.optional() }),
  }),
  z.strictObject({ kind: z.literal('cancelled') }),
  z.strictObject({ kind: z.literal('failed'), reason: ModelFailureSchema.shape.code }),
]);

/** Settled turn outcome. */
export type AgentStepTurnResult = z.infer<typeof AgentStepTurnResultSchema>;

/** A start acknowledges dispatch immediately. The single turn settles separately. */
export type AgentStepExecution =
  | { readonly start: Extract<StartAgentResponse, { success: true }>; readonly turn: Promise<AgentStepTurnResult> }
  | {
      readonly start: Extract<StartAgentResponse, { success: false }>;
      readonly turn?: never;
      readonly reason?: 'prompt-too-large';
    };

/** Worker-facing adapter boundary for an isolated agent step. */
export interface AgentStepAdapter {
  readonly capabilities: z.infer<typeof AgentStepCapabilitiesSchema>;
  start(input: unknown, signal: AbortSignal): AgentStepExecution;
}

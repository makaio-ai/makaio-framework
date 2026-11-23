import { AdapterSchemas, StartAgentSchema, type StartAgentResponse } from '@makaio/contracts/adapter';
import { NoAdapterAuthDeliverySchema } from '@makaio/contracts/auth';
import { z } from 'zod';

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

const TextSchema = z.string().min(1).max(16_384);

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
]);
/** A fixed diagnostic without upstream data. */
export type ModelFailureCode = z.infer<typeof ModelFailureCodeSchema>;
/** Wire error envelope used by the model endpoint. */
export const ModelFailureSchema = z.object({ code: z.string().min(1).max(128) });
/** Worker-scoped model request. */
export type AgentModelRequest = z.infer<typeof AgentModelRequestSchema>;
/** Text reply and optional usage. */
export type AgentModelReply = z.infer<typeof AgentModelReplySchema>;

/** Schema for a settled turn. */
export const AgentStepTurnResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('completed'), result: AgentModelReplySchema }),
  z.strictObject({ kind: z.literal('cancelled') }),
  z.strictObject({ kind: z.literal('failed'), reason: ModelFailureSchema.shape.code }),
]);

/** Settled turn outcome. */
export type AgentStepTurnResult = z.infer<typeof AgentStepTurnResultSchema>;

/** A start acknowledges dispatch immediately. The single turn settles separately. */
export type AgentStepExecution =
  | { readonly start: Extract<StartAgentResponse, { success: true }>; readonly turn: Promise<AgentStepTurnResult> }
  | { readonly start: Extract<StartAgentResponse, { success: false }>; readonly turn?: never };

/** Worker-facing adapter boundary for an isolated agent step. */
export interface AgentStepAdapter {
  readonly capabilities: z.infer<typeof AgentStepCapabilitiesSchema>;
  start(input: unknown, signal: AbortSignal): AgentStepExecution;
}

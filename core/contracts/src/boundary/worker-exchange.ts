import { z } from 'zod';
import { JsonValueSchema } from '../shared/json-value.js';

/** The smaller default message limit of the supported WebSocket hosts (Bun, 16 MiB). */
export const WORKER_EXCHANGE_MAX_BYTES = 16 * 1024 * 1024;

/** Name of the built-in exchange for an ordered worker. */
export const WORKER_REDEMPTION_EXCHANGE = 'makaio.worker.redeem';

/** Bootstrap proof and credentials carried in a single setup message. */
export const WorkerExchangeRequestSchema = z.strictObject({
  type: z.literal('connection-exchange'),
  exchange: z.literal(WORKER_REDEMPTION_EXCHANGE),
  presented: z.strictObject({
    jobRunId: z.string().min(1),
    oneTimeToken: z.string().min(1),
    runtimeSecret: z.string().min(1),
    proof: JsonValueSchema,
  }),
});

/** Bootstrap request on the worker setup connection. */
export type WorkerExchangeRequest = z.infer<typeof WorkerExchangeRequestSchema>;

/** An already redeemed run presenting its runtime credential over verified TLS. */
export const WorkerRunIdentityRequestSchema = z.strictObject({
  kind: z.literal('job-run'),
  jobRunId: z.string().min(1),
  runtimeSecret: z.string().min(1),
});

/** Identity presentation for a subsequent connection. */
export type WorkerRunIdentityRequest = z.infer<typeof WorkerRunIdentityRequestSchema>;

/** Confirmation of the original run identity and its unchanged expiry. */
export const WorkerRunIdentityReplySchema = z.strictObject({
  type: z.literal('connection-exchange-result'),
  identity: z.strictObject({
    jobRunId: z.string().min(1),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
});

/** A committed opaque payload or the generic refusal. */
export const WorkerExchangeReplySchema = z.union([
  z.strictObject({ type: z.literal('connection-exchange-result'), payload: JsonValueSchema }),
  z.strictObject({ type: z.literal('connection-exchange-result'), reject: z.literal('rejected') }),
]);

/** Reply containing only the opaque application payload or a generic refusal. */
export type WorkerExchangeReply = Readonly<z.infer<typeof WorkerExchangeReplySchema>>;

import { z } from 'zod';
import { JsonValueSchema, type JsonValue } from '../shared/json-value.js';

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

/** Reply containing only the opaque application payload or a generic refusal. */
export type WorkerExchangeReply =
  | { readonly type: 'connection-exchange-result'; readonly payload: JsonValue }
  | { readonly type: 'connection-exchange-result'; readonly reject: 'rejected' };

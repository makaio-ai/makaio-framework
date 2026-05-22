import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Request payload for deterministic adapter-id resolution.
 */
export const ResolveIdRequestSchema = z
  .object({
    adapterName: z.string(),
    machineId: z.string().optional(),
  })
  .strict();

/**
 * Response payload for deterministic adapter-id resolution.
 */
export const ResolveIdResponseSchema = z
  .object({
    adapterId: z.string(),
  })
  .strict();

/**
 * Reverse-lookup request payload for runtime adapter identity.
 */
export const ResolveNameRequestSchema = z
  .object({
    adapterId: z.string(),
  })
  .strict();

/**
 * Reverse-lookup response payload for runtime adapter identity.
 */
export const ResolveNameResponseSchema = z
  .object({
    adapterName: z.string(),
  })
  .strict();

/**
 * Inferred request payload for deterministic adapter-id resolution.
 */
export type ResolveIdRequest = z.infer<typeof ResolveIdRequestSchema>;

/**
 * Inferred response payload for deterministic adapter-id resolution.
 */
export type ResolveIdResponse = z.infer<typeof ResolveIdResponseSchema>;

/**
 * Inferred request payload for runtime adapter reverse lookup.
 */
export type ResolveNameRequest = z.infer<typeof ResolveNameRequestSchema>;

/**
 * Inferred response payload for runtime adapter reverse lookup.
 */
export type ResolveNameResponse = z.infer<typeof ResolveNameResponseSchema>;

/**
 * Schemas for the `adapterRuntime` namespace.
 *
 * This runtime seam owns live adapter identity. Canonical config and bindings
 * stay in `adapterSubsystem.*`; adapter implementation RPCs stay in
 * `adapter.*`. Dynamic adapter loading flows through
 * `extension.setEnabled` via the coordinator, not a dedicated RPC.
 */
export const AdapterRuntimeSchemas = {
  resolveId: {
    request: ResolveIdRequestSchema,
    response: ResolveIdResponseSchema,
  },

  resolveName: {
    request: ResolveNameRequestSchema,
    response: ResolveNameResponseSchema,
  },
} satisfies SchemaRecord;

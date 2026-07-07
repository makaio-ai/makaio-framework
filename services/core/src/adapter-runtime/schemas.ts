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
 * Request payload for querying the runtime machine identity.
 *
 * Intentionally empty — the handler resolves the identity from the
 * `AdapterIdentityRegistry` that was configured at startup.
 */
export const GetMachineIdRequestSchema = z.object({}).strict();

/**
 * Response payload for the runtime machine identity query.
 */
export const GetMachineIdResponseSchema = z
  .object({
    /** Runtime machine identifier, absent when no identity was configured. */
    machineId: z.string().optional(),
  })
  .strict();

/**
 * Inferred request payload for machine identity query.
 */
export type GetMachineIdRequest = z.infer<typeof GetMachineIdRequestSchema>;

/**
 * Inferred response payload for machine identity query.
 */
export type GetMachineIdResponse = z.infer<typeof GetMachineIdResponseSchema>;

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

  getMachineId: {
    request: GetMachineIdRequestSchema,
    response: GetMachineIdResponseSchema,
  },
} satisfies SchemaRecord;

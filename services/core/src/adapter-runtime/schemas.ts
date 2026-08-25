import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ConnectorTeardownResultSchema } from '@makaio/contracts';

/**
 * Request payload for runtime adapter-id resolution.
 */
export const ResolveIdRequestSchema = z
  .object({
    adapterName: z.string(),
    machineId: z.string().optional(),
  })
  .strict();

/**
 * Response payload for runtime adapter-id resolution.
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
 * Request payload for proving that one complete adapter identity is live.
 *
 * Unlike reverse lookup, this operation is backed exclusively by an
 * `adapter.initialized` announcement. It therefore accepts opaque host IDs and
 * never reconstructs an identity from deterministic naming conventions.
 */
export const ResolveLiveIdentityRequestSchema = z
  .object({
    adapterId: z.string(),
    adapterName: z.string(),
    machineId: z.string(),
    /** Omit only to prove a uniquely live owner for the supplied triple. */
    ownerInstanceId: z.string().optional(),
  })
  .strict();

/** Response payload for a proved live adapter identity. */
export const ResolveLiveIdentityResponseSchema = ResolveLiveIdentityRequestSchema.extend({
  /** Exact runtime incarnation that owns the dispatchable adapter instance. */
  ownerInstanceId: z.string(),
});

/**
 * Inferred request payload for runtime adapter-id resolution.
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

/** Inferred request payload for live adapter identity proof. */
export type ResolveLiveIdentityRequest = z.infer<typeof ResolveLiveIdentityRequestSchema>;

/** Inferred response payload for live adapter identity proof. */
export type ResolveLiveIdentityResponse = z.infer<typeof ResolveLiveIdentityResponseSchema>;

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

  /** Prove an exact adapter ID/name/machine triple from a live announcement. */
  resolveLiveIdentity: {
    request: ResolveLiveIdentityRequestSchema,
    response: ResolveLiveIdentityResponseSchema,
  },

  getMachineId: {
    request: GetMachineIdRequestSchema,
    response: GetMachineIdResponseSchema,
  },

  /**
   * Aggregate result observed while the local adapter runtime shut down.
   *
   * This is a fact emitted by the lifecycle owner, not a request another
   * component can use to initiate teardown. Ownership retirement consumes it
   * only after package ordering has destroyed the adapter subsystem.
   */
  teardownCompleted: ConnectorTeardownResultSchema.extend({
    /** Ownership-authority incarnation whose adapter runtime produced the evidence. */
    ownerInstanceId: z.string().nullable(),
  }),
} satisfies SchemaRecord;

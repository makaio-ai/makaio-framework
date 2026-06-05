import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { SurfaceBindingRegistrationSchema } from './schemas.js';

/**
 * Framework-level materialization bus schemas.
 *
 * Defines the RPC and event subjects for framework-level materialization
 * coordination.
 * The schema set covers:
 *
 * - `surfaceBinding.register` — register a surface binding with the registry (RPC)
 * - `surfaceBinding.list` — query registered surface bindings (RPC)
 * - `surfaceBinding.changed` — emitted when a surface binding is added (event)
 * - `ref.changed` — emitted when a provider materialization ref changes (event)
 * - `capability.resolved` — emitted when a provider surface capability set is resolved (event)
 *
 * Product hosts that extend the framework materialization surface should
 * register a product-owned namespace rather than merging additional subjects
 * into this one.
 */
export const MaterializationSchemas = {
  /**
   * Register a surface binding with the surface binding registry (RPC).
   * Returns `{ registered: true }` when successfully stored.
   */
  'surfaceBinding.register': {
    request: SurfaceBindingRegistrationSchema,
    response: z.object({ registered: z.boolean() }),
  },

  /** List registered surface bindings, optionally filtered by provider or namespace (RPC). */
  'surfaceBinding.list': {
    request: z.object({
      /** Restrict results to a single provider identifier. */
      provider: z.string().min(1).optional(),
      /** Restrict results to a single namespace identifier. */
      namespace: z.string().min(1).optional(),
    }),
    response: z.object({ bindings: z.array(SurfaceBindingRegistrationSchema) }),
  },

  /** Emitted when a surface binding registration is added. */
  'surfaceBinding.changed': z.object({
    /** Stable binding identifier that was added. */
    id: z.string().min(1),
    /** Provider the binding targets. */
    provider: z.string().min(1),
  }),

  /** Emitted when a provider materialization ref is upserted or deleted. */
  'ref.changed': z.object({
    /** Stable framework artifact identity whose materialization ref changed. */
    artifactId: z.string().min(1),
    /** Provider that owns the external object. */
    provider: z.string().min(1),
    /** Provider-owned external object identifier. */
    externalId: z.string().min(1),
    /** Storage operation that changed the materialization ref. */
    operation: z.enum(['upserted', 'deleted']),
  }),

  /** Emitted when a provider surface capability set has been resolved. */
  'capability.resolved': z.object({
    /** Provider that owns the external surface. */
    provider: z.string().min(1),
    /** Provider surface whose capabilities were resolved. */
    surface: z.string().min(1),
    /** Capability flags keyed by provider-neutral capability name. */
    capabilities: z.record(z.string().min(1), z.boolean()),
    /** True when at least one optional capability is unavailable. */
    degraded: z.boolean(),
  }),
} satisfies SchemaRecord;

/**
 * Materialization bus namespace.
 *
 * Registers the `materialization` namespace with framework-level RPC and event
 * subjects. Use `MaterializationSubjects` to access typed bus subject
 * descriptors.
 */
export const MaterializationNamespace = createBusNamespace('materialization', MaterializationSchemas);

/**
 * Typed subjects for materialization bus communication.
 *
 * Available subjects:
 * - `MaterializationSubjects['surfaceBinding.register']` — register a surface binding (RPC)
 * - `MaterializationSubjects['surfaceBinding.list']` — list surface bindings (RPC)
 * - `MaterializationSubjects['surfaceBinding.changed']` — binding changed event
 * - `MaterializationSubjects['ref.changed']` — materialization ref changed event
 * - `MaterializationSubjects['capability.resolved']` — provider capability resolved event
 *
 * Nested shorthand (via dot-segment nesting):
 * - `MaterializationSubjects.surfaceBinding.register` — register (RPC)
 * - `MaterializationSubjects.surfaceBinding.list` — list (RPC)
 * - `MaterializationSubjects.surfaceBinding.changed` — changed event
 * - `MaterializationSubjects.ref.changed` — ref changed event
 * - `MaterializationSubjects.capability.resolved` — capability resolved event
 */
export const MaterializationSubjects = MaterializationNamespace.subjects;

// ---------------------------------------------------------------------------
// RPC request / response types
// ---------------------------------------------------------------------------

/** Request payload for registering a surface binding. */
export type SurfaceBindingRegisterRequest = z.infer<
  (typeof MaterializationSchemas)['surfaceBinding.register']['request']
>;

/** Response payload for registering a surface binding. */
export type SurfaceBindingRegisterResponse = z.infer<
  (typeof MaterializationSchemas)['surfaceBinding.register']['response']
>;

/** Request payload for listing surface bindings. */
export type SurfaceBindingListRequest = z.infer<(typeof MaterializationSchemas)['surfaceBinding.list']['request']>;

/** Response payload for listing surface bindings. */
export type SurfaceBindingListResponse = z.infer<(typeof MaterializationSchemas)['surfaceBinding.list']['response']>;

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/** Payload for the surface binding changed event. */
export type SurfaceBindingChangedPayload = z.infer<(typeof MaterializationSchemas)['surfaceBinding.changed']>;

/** Payload for the materialization ref changed event. */
export type MaterializationRefChangedPayload = z.infer<(typeof MaterializationSchemas)['ref.changed']>;

/** Payload for the materialization capability resolved event. */
export type MaterializationCapabilityResolvedPayload = z.infer<(typeof MaterializationSchemas)['capability.resolved']>;

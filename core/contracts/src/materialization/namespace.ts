import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { SurfaceBindingRegistrationSchema } from './schemas.js';
import { ArtifactViewAffordanceRequestSchema, ArtifactViewRequestSchema } from './view-builder.js';
import { ArtifactViewModelSchema } from './view-model.js';

/* -------------------------------------------------------------------------- */
/*  Artifact view resolve request / response schemas                          */
/* -------------------------------------------------------------------------- */

/**
 * Request payload for resolving an artifact view through an affordance.
 *
 * Extends {@link ArtifactViewRequestSchema} (`level` + optional `params`)
 * with the artifact identity and the structural affordance selector — the
 * resolve RPC reuses the shared view-request shape rather than re-declaring
 * parallel parameter types.
 * @param ref - Stable framework artifact identity.
 * @param level - Requested detail level (`link`, `summary`, or `full`).
 * @param affordance - Structural affordance selector (own-view, inline, or entry).
 * @param params - Optional JSON-safe runtime parameters.
 */
export const ArtifactViewResolveRequestSchema = ArtifactViewRequestSchema.extend({
  /** Stable framework artifact identity. */
  ref: z.string().min(1),
  /** Structural affordance selector for the view. */
  affordance: ArtifactViewAffordanceRequestSchema,
});

/** Request payload for resolving an artifact view. */
export type ArtifactViewResolveRequest = z.infer<typeof ArtifactViewResolveRequestSchema>;

/**
 * Discriminated response for an artifact view resolve request.
 *
 * Exactly three closed shapes:
 * - `ok` — positive result with the rendered view, its builder version, and
 *   the exact artifact revision that produced the view.
 * - `artifact-not-found` — the referenced artifact does not exist.
 * - `not-rendered` — the artifact exists but the requested affordance is not
 *   available or the projection policy suppresses rendering.
 */
export const ArtifactViewResolveResponseSchema = z.discriminatedUnion('status', [
  z.object({
    /** Result discriminant: the view was successfully rendered. */
    status: z.literal('ok'),
    /** Rendered artifact view model. */
    view: ArtifactViewModelSchema,
    /** Positive integer builder version that produced this view. */
    builderVersion: z.number().int().positive(),
    /** Exact artifact revision resolved to produce this view. */
    sourceRevision: z.string().min(1),
  }),
  z.object({
    /** Result discriminant: the artifact was not found. */
    status: z.literal('artifact-not-found'),
    /** Always `null` for error variants. */
    view: z.null(),
  }),
  z.object({
    /** Result discriminant: the artifact was not rendered. */
    status: z.literal('not-rendered'),
    /** Always `null` for error variants. */
    view: z.null(),
  }),
]);

/** Response payload for an artifact view resolve request. */
export type ArtifactViewResolveResponse = z.infer<typeof ArtifactViewResolveResponseSchema>;

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
 * - `artifact.view.resolve` — resolve an artifact view through an affordance (RPC)
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

  /** List registered surface bindings, optionally filtered by id, provider, or namespace (RPC). */
  'surfaceBinding.list': {
    request: z.object({
      /** Restrict results to a single binding identifier for exact lookup. */
      id: z.string().min(1).optional(),
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
    /**
     * Optional materialization origin provenance.
     *
     * - `'factory'` — the change originated from the artifact storage layer
     *   through an artifact ref upsert or delete.
     * - `'external'` — the change originated from an external system
     *   (e.g. inbound sync from a provider).
     *
     * Omitted origin is valid for backward compatibility with existing
     * emitters that predate this field.
     */
    origin: z.enum(['factory', 'external']).optional(),
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

  /**
   * Resolve an artifact view through an affordance (RPC).
   *
   * Returns one of three closed response shapes: `ok` with the rendered view,
   * its builder version, and exact source revision; `artifact-not-found`; or
   * `not-rendered`.
   */
  'artifact.view.resolve': {
    request: ArtifactViewResolveRequestSchema,
    response: ArtifactViewResolveResponseSchema,
  },
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
 * - `MaterializationSubjects['artifact.view.resolve']` — resolve an artifact view (RPC)
 *
 * Nested shorthand (via dot-segment nesting):
 * - `MaterializationSubjects.surfaceBinding.register` — register (RPC)
 * - `MaterializationSubjects.surfaceBinding.list` — list (RPC)
 * - `MaterializationSubjects.surfaceBinding.changed` — changed event
 * - `MaterializationSubjects.ref.changed` — ref changed event
 * - `MaterializationSubjects.capability.resolved` — capability resolved event
 * - `MaterializationSubjects.artifact.view.resolve` — resolve artifact view (RPC)
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

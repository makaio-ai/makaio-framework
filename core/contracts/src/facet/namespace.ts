import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { FacetNamespaceRegistrationSchema } from './schemas.js';

/**
 * Framework-level facet bus schemas.
 *
 * Defines the RPC and event subjects for the facet namespace registry.
 * The schema set covers:
 *
 * - `namespace.register` — register a new facet namespace with the facet service (RPC)
 * - `namespace.list` — query registered facet namespaces (RPC)
 * - `namespace.changed` — emitted when a facet namespace registration is added or updated (event)
 *
 * Product hosts that extend the framework facet namespace should register a
 * product-owned namespace rather than merging additional subjects into this one.
 */
export const FacetSchemas = {
  /**
   * Register a new facet namespace with the facet service (RPC).
   * Returns `{ registered: true }` when successfully stored.
   */
  'namespace.register': {
    request: FacetNamespaceRegistrationSchema,
    response: z.object({ registered: z.boolean() }),
  },

  /** List registered facet namespaces, optionally filtered by namespace string (RPC). */
  'namespace.list': {
    request: z.object({ namespace: z.string().min(1).optional() }),
    response: z.object({ namespaces: z.array(FacetNamespaceRegistrationSchema) }),
  },

  /** Emitted when a facet namespace registration is added or updated. */
  'namespace.changed': z.object({
    /** Namespace identifier that changed. */
    namespace: z.string().min(1),
  }),
} satisfies SchemaRecord;

/**
 * Facet bus namespace.
 *
 * Registers the `facet` namespace with framework-level RPC and event subjects
 * for the facet namespace registry. Use `FacetSubjects` to access typed bus
 * subject descriptors.
 */
export const FacetNamespace = createBusNamespace('facet', FacetSchemas);

/**
 * Typed subjects for facet bus communication.
 *
 * Available subjects:
 * - `FacetSubjects['namespace.register']` — register a facet namespace (RPC)
 * - `FacetSubjects['namespace.list']` — list facet namespaces (RPC)
 * - `FacetSubjects['namespace.changed']` — facet namespace changed event
 *
 * Nested shorthand (via dot-segment nesting):
 * - `FacetSubjects.namespace.register` — register (RPC)
 * - `FacetSubjects.namespace.list` — list (RPC)
 * - `FacetSubjects.namespace.changed` — changed event
 */
export const FacetSubjects = FacetNamespace.subjects;

// ---------------------------------------------------------------------------
// RPC request / response types
// ---------------------------------------------------------------------------

/** Request payload for registering a facet namespace. */
export type FacetNamespaceRegisterRequest = z.infer<(typeof FacetSchemas)['namespace.register']['request']>;

/** Response payload for registering a facet namespace. */
export type FacetNamespaceRegisterResponse = z.infer<(typeof FacetSchemas)['namespace.register']['response']>;

/** Request payload for listing facet namespaces. */
export type FacetNamespaceListRequest = z.infer<(typeof FacetSchemas)['namespace.list']['request']>;

/** Response payload for listing facet namespaces. */
export type FacetNamespaceListResponse = z.infer<(typeof FacetSchemas)['namespace.list']['response']>;

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/** Payload for the facet namespace changed event. */
export type FacetNamespaceChangedPayload = z.infer<(typeof FacetSchemas)['namespace.changed']>;

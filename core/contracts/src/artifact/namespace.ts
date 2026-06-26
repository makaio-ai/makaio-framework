import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import {
  ArtifactCompareRequestSchema,
  ArtifactCompareResponseSchema,
  ArtifactKindRegistrationSchema,
  ArtifactObservationSchema,
  ArtifactQueryRequestSchema,
  ArtifactRefSchema,
  ArtifactRelationSchema,
  ArtifactRevisionSchema,
  RelationTypeRegistrationSchema,
} from './schemas.js';
import { ArtifactContextSelectorSchema } from './context-selectors.js';
import { ResolvedArtifactContextWireSchema } from './context-resolution.js';

/**
 * Framework-level artifact bus schemas.
 *
 * Defines the full set of lifecycle events and core RPCs for hosts that
 * opt into the framework artifact contract. The schema set covers:
 *
 * - Kind and relation-type registration RPCs
 * - Revision create / revise / resolve / query / compare RPCs
 * - `created`, `revised`, `relation.added`, `observation.added`,
 *   `status.changed`, and `kind.changed` lifecycle events
 *
 * Product hosts that extend the framework artifact namespace should
 * register a product-owned namespace instead of merging additional
 * subjects into this one.
 */
export const ArtifactSchemas = {
  /** Register a new artifact kind with the artifact service (RPC). */
  'kind.register': {
    request: ArtifactKindRegistrationSchema,
    response: z.object({ registered: z.boolean() }),
  },

  /** List registered artifact kinds, optionally filtered by kind string (RPC). */
  'kind.list': {
    request: z.object({ kind: z.string().min(1).optional() }),
    response: z.object({ kinds: z.array(ArtifactKindRegistrationSchema) }),
  },

  /** Register a new relation type with the artifact service (RPC). */
  'relation-type.register': {
    request: RelationTypeRegistrationSchema,
    response: z.object({ registered: z.boolean() }),
  },

  /** List registered relation types, optionally filtered by type string (RPC). */
  'relation-type.list': {
    request: z.object({ type: z.string().min(1).optional() }),
    response: z.object({ relationTypes: z.array(RelationTypeRegistrationSchema) }),
  },

  /** Create a new artifact and its first revision (RPC). */
  create: {
    request: ArtifactRevisionSchema.omit({ id: true, revision: true, timestamp: true }),
    response: z.object({ artifact: ArtifactRevisionSchema }),
  },

  /** Create a new revision of an existing artifact (RPC). */
  revise: {
    request: z.object({
      previous: ArtifactRefSchema,
      revision: ArtifactRevisionSchema.omit({ id: true, revision: true, timestamp: true }),
    }),
    response: z.object({ artifact: ArtifactRevisionSchema }),
  },

  /** Resolve a specific artifact revision by reference (RPC). */
  resolve: {
    request: z.object({ ref: ArtifactRefSchema }),
    response: z.object({ artifact: ArtifactRevisionSchema.nullable() }),
  },

  /** Query artifact revisions using structured filter criteria (RPC). */
  query: {
    request: ArtifactQueryRequestSchema,
    response: z.object({ artifacts: z.array(ArtifactRevisionSchema) }),
  },

  /** Compare two artifact revisions and return changed paths (RPC). */
  compare: {
    request: ArtifactCompareRequestSchema,
    response: ArtifactCompareResponseSchema,
  },

  /** Resolve a selector-driven outbound artifact context graph (RPC). */
  resolveContext: {
    request: z.object({
      /** Exact artifact revision to resolve from. */
      ref: ArtifactRefSchema,
      /** Optional caller selectors. Missing relation types fall through to kind defaults. */
      selectors: ArtifactContextSelectorSchema.optional(),
      /** Maximum total traversal depth safety limit. */
      maxDepth: z.number().int().min(1).max(20).default(5),
    }),
    response: z.object({ context: ResolvedArtifactContextWireSchema }),
  },

  /** Emitted when a new artifact is created. */
  created: z.object({ artifact: ArtifactRevisionSchema }),

  /** Emitted when an existing artifact receives a new revision. */
  revised: z.object({ previous: ArtifactRefSchema, artifact: ArtifactRevisionSchema }),

  /** Emitted when a relation is added to an artifact revision. */
  'relation.added': z.object({
    artifact: ArtifactRefSchema,
    relation: ArtifactRelationSchema,
  }),

  /** Emitted when an observation is added to an artifact revision. */
  'observation.added': z.object({
    artifact: ArtifactRefSchema,
    observation: ArtifactObservationSchema,
  }),

  /** Emitted when a tracked status field changes on an artifact revision. */
  'status.changed': z.object({
    artifact: ArtifactRefSchema,
    /** JSON Pointer path to the status field that changed. */
    path: z.string().min(1),
    /** Previous status value (absent if the field was newly set). */
    previous: z.unknown().optional(),
    /** Current status value (absent if the field was cleared). */
    current: z.unknown().optional(),
  }),

  /** Emitted when an artifact kind registration is added or updated. */
  'kind.changed': z.object({
    /** Kind string that changed. */
    kind: z.string().min(1),
    /** Schema version of the updated registration. */
    schemaVersion: z.string().min(1),
  }),
} satisfies SchemaRecord;

/**
 * Artifact bus namespace.
 *
 * Registers the `artifact` namespace with framework-level lifecycle events
 * and core RPCs. Use `ArtifactSubjects` to access typed bus subject
 * descriptors.
 */
export const ArtifactNamespace = createBusNamespace('artifact', ArtifactSchemas);

/**
 * Typed subjects for artifact bus communication.
 *
 * Available subjects:
 * - `ArtifactSubjects['kind.register']` — register a kind (RPC)
 * - `ArtifactSubjects['kind.list']` — list kinds (RPC)
 * - `ArtifactSubjects['relation-type.register']` — register a relation type (RPC)
 * - `ArtifactSubjects['relation-type.list']` — list relation types (RPC)
 * - `ArtifactSubjects.create` — create artifact (RPC)
 * - `ArtifactSubjects.revise` — revise artifact (RPC)
 * - `ArtifactSubjects.resolve` — resolve artifact by ref (RPC)
 * - `ArtifactSubjects.query` — query artifacts (RPC)
 * - `ArtifactSubjects.compare` — compare two revisions (RPC)
 * - `ArtifactSubjects.resolveContext` — resolve artifact context graph (RPC)
 * - `ArtifactSubjects.created` — artifact created event
 * - `ArtifactSubjects.revised` — artifact revised event
 * - `ArtifactSubjects['relation.added']` — relation added event
 * - `ArtifactSubjects['observation.added']` — observation added event
 * - `ArtifactSubjects['status.changed']` — status changed event
 * - `ArtifactSubjects['kind.changed']` — kind registration changed event
 */
export const ArtifactSubjects = ArtifactNamespace.subjects;

// ---------------------------------------------------------------------------
// RPC request/response types
// ---------------------------------------------------------------------------

/** Request payload for registering an artifact kind. */
export type ArtifactKindRegisterRequest = z.infer<(typeof ArtifactSchemas)['kind.register']['request']>;

/** Response payload for registering an artifact kind. */
export type ArtifactKindRegisterResponse = z.infer<(typeof ArtifactSchemas)['kind.register']['response']>;

/** Request payload for listing artifact kinds. */
export type ArtifactKindListRequest = z.infer<(typeof ArtifactSchemas)['kind.list']['request']>;

/** Response payload for listing artifact kinds. */
export type ArtifactKindListResponse = z.infer<(typeof ArtifactSchemas)['kind.list']['response']>;

/** Request payload for registering a relation type. */
export type ArtifactRelationTypeRegisterRequest = z.infer<
  (typeof ArtifactSchemas)['relation-type.register']['request']
>;

/** Response payload for registering a relation type. */
export type ArtifactRelationTypeRegisterResponse = z.infer<
  (typeof ArtifactSchemas)['relation-type.register']['response']
>;

/** Request payload for listing relation types. */
export type ArtifactRelationTypeListRequest = z.infer<(typeof ArtifactSchemas)['relation-type.list']['request']>;

/** Response payload for listing relation types. */
export type ArtifactRelationTypeListResponse = z.infer<(typeof ArtifactSchemas)['relation-type.list']['response']>;

/** Request payload for creating a new artifact. */
export type ArtifactCreateRequest = z.infer<(typeof ArtifactSchemas)['create']['request']>;

/** Response payload for creating a new artifact. */
export type ArtifactCreateResponse = z.infer<(typeof ArtifactSchemas)['create']['response']>;

/** Request payload for creating a new artifact revision. */
export type ArtifactReviseRequest = z.infer<(typeof ArtifactSchemas)['revise']['request']>;

/** Response payload for creating a new artifact revision. */
export type ArtifactReviseResponse = z.infer<(typeof ArtifactSchemas)['revise']['response']>;

/** Request payload for resolving an artifact by reference. */
export type ArtifactResolveRequest = z.infer<(typeof ArtifactSchemas)['resolve']['request']>;

/** Response payload for resolving an artifact by reference. */
export type ArtifactResolveResponse = z.infer<(typeof ArtifactSchemas)['resolve']['response']>;

/** Response payload for querying artifacts. */
export type ArtifactQueryResponse = z.infer<(typeof ArtifactSchemas)['query']['response']>;

/** Request payload for resolving artifact context. */
export type ArtifactResolveContextRequest = z.infer<(typeof ArtifactSchemas)['resolveContext']['request']>;

/** Response payload for resolving artifact context. */
export type ArtifactResolveContextResponse = z.infer<(typeof ArtifactSchemas)['resolveContext']['response']>;

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/** Payload for the artifact created event. */
export type ArtifactCreatedPayload = z.infer<(typeof ArtifactSchemas)['created']>;

/** Payload for the artifact revised event. */
export type ArtifactRevisedPayload = z.infer<(typeof ArtifactSchemas)['revised']>;

/** Payload for the relation added event. */
export type ArtifactRelationAddedPayload = z.infer<(typeof ArtifactSchemas)['relation.added']>;

/** Payload for the observation added event. */
export type ArtifactObservationAddedPayload = z.infer<(typeof ArtifactSchemas)['observation.added']>;

/** Payload for the status changed event. */
export type ArtifactStatusChangedPayload = z.infer<(typeof ArtifactSchemas)['status.changed']>;

/** Payload for the kind registration changed event. */
export type ArtifactKindChangedPayload = z.infer<(typeof ArtifactSchemas)['kind.changed']>;

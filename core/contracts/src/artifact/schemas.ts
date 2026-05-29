import { z } from 'zod';

import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';

/**
 * Identifies the actor (agent, user, system) that produced or asserted
 * an artifact revision or confidence basis.
 */
export const ArtifactActorSchema = z.object({
  /** Actor kind, e.g. `'agent'`, `'user'`, `'system'`. */
  kind: z.string().min(1),
  /** Stable identifier for the actor within its kind. */
  id: z.string().min(1),
  /** Optional human-readable display name. */
  displayName: z.string().optional(),
});

/**
 * Describes the scope at which an artifact revision is relevant.
 *
 * `level` is an open string (e.g. `'session'`, `'project'`, `'global'`)
 * so that product-owned kinds can declare domain-specific scope levels
 * without modifying the framework contract.
 *
 * `ids` carries the scope-identifying foreign keys when `level` names a
 * concrete artifact owner. Query filters use {@link ArtifactQueryScopeSchema}
 * because level-only queries are valid there but not for persisted revisions.
 */
export const ArtifactScopeSchema = z
  .object({
    /** Scope level string (open-ended). */
    level: z.string().min(1),
    /** Scope-identifying keys — required when `level` is not global. */
    ids: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.level !== 'global' && (!value.ids || Object.keys(value.ids).length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ids'],
        message: "ids is required when scope level is not 'global'",
      });
    }
  });

/**
 * Scope filter for artifact queries.
 *
 * Unlike persisted artifact scopes, query scopes may be level-only to request
 * all revisions at a level, e.g. `{ level: 'session' }`.
 */
export const ArtifactQueryScopeSchema = z.object({
  /** Scope level string (open-ended). */
  level: z.string().min(1),
  /** Optional scope-identifying keys used to narrow the query. */
  ids: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/**
 * An immutable pointer to a specific revision of an artifact.
 *
 * All three fields together uniquely identify a persisted snapshot
 * and are safe to store as foreign keys.
 *
 * `refClass` is a literal discriminant that allows {@link ArtifactRelationTargetSchema}
 * to use a discriminated union and prevents silent field-stripping when an
 * {@link EvidenceRefSchema} carrying a `locator` is parsed against this schema.
 */
export const ArtifactRefSchema = z.object({
  /** Literal discriminant for {@link ArtifactRelationTargetSchema}. Always `'artifact'`. */
  refClass: z.literal('artifact').default('artifact'),
  /** Kind discriminator, matching {@link ArtifactKindRegistrationSchema.kind}. */
  kind: z.string().min(1),
  /** Stable artifact identity (does not change across revisions). */
  id: z.string().min(1),
  /** Revision identifier (e.g. nanoid or monotone counter). */
  revision: z.string().min(1),
});

/**
 * A pointer to a named sub-element within a specific artifact revision.
 *
 * Used when a relation target is a structural part of an artifact rather
 * than the artifact itself (e.g. a specific line in a code-review artifact).
 *
 * `refClass` is a literal discriminant for {@link ArtifactRelationTargetSchema}.
 */
export const LocalRefSchema = z.object({
  /** Literal discriminant for {@link ArtifactRelationTargetSchema}. Always `'local'`. */
  refClass: z.literal('local').default('local'),
  /** The containing artifact revision. */
  artifact: ArtifactRefSchema,
  /** Local identifier of the sub-element within that revision. */
  localId: z.string().min(1),
});

/**
 * A pointer to external evidence — a source outside the artifact store.
 *
 * `revision` and `locator` are both optional so callers can supply as
 * much precision as is available (e.g. a commit SHA + file path, or just
 * a document URL).
 *
 * `refClass` is a literal discriminant for {@link ArtifactRelationTargetSchema}.
 */
export const EvidenceRefSchema = z.object({
  /** Literal discriminant for {@link ArtifactRelationTargetSchema}. Always `'evidence'`. */
  refClass: z.literal('evidence').default('evidence'),
  /** Evidence kind, e.g. `'commit'`, `'file'`, `'url'`. */
  kind: z.string().min(1),
  /** Stable identifier within the evidence kind. */
  id: z.string().min(1),
  /** Optional point-in-time revision identifier. */
  revision: z.string().min(1).optional(),
  /** Optional locator within the evidence (e.g. a line range or fragment). */
  locator: z.string().min(1).optional(),
});

/**
 * Discriminated union of all valid relation-target reference classes.
 *
 * Routing is keyed on the `refClass` literal field present in each variant,
 * which prevents silent field-stripping that occurs with plain unions when two
 * variants share a common required-field set (e.g. an {@link EvidenceRefSchema}
 * carrying both `revision` and `locator` being matched by {@link ArtifactRefSchema}).
 *
 * - `'artifact'` → {@link ArtifactRefSchema} — whole artifact revision
 * - `'local'` → {@link LocalRefSchema} — sub-element within an artifact revision
 * - `'evidence'` → {@link EvidenceRefSchema} — external evidence source
 */
const ArtifactRelationTargetDiscriminatedSchema = z.discriminatedUnion('refClass', [
  ArtifactRefSchema,
  LocalRefSchema,
  EvidenceRefSchema,
]);

/**
 * Infer the default `refClass` for legacy wire payloads before the
 * discriminated union routes the target to a concrete schema.
 * @param value - Raw relation target candidate.
 * @returns Relation target candidate with an explicit discriminator when it can be inferred.
 */
function inferArtifactRelationTargetRefClass(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'refClass' in value) {
    return value;
  }

  if ('artifact' in value && 'localId' in value) {
    return { ...value, refClass: 'local' };
  }

  if ('locator' in value || !('revision' in value)) {
    return { ...value, refClass: 'evidence' };
  }

  return { ...value, refClass: 'artifact' };
}

export const ArtifactRelationTargetSchema = z.preprocess(
  inferArtifactRelationTargetRefClass,
  ArtifactRelationTargetDiscriminatedSchema,
);

/**
 * A typed directional link from one artifact to a relation target.
 *
 * `type` is an open string registered via {@link RelationTypeRegistrationSchema}.
 */
export const ArtifactRelationSchema = z.object({
  /** Relation type string (must match a registered relation type). */
  type: z.string().min(1),
  /** The target of this relation. */
  target: ArtifactRelationTargetSchema,
});

/**
 * Ordered confidence levels for artifact assertions.
 *
 * Levels progress from weakest to strongest epistemic warrant:
 * `assumed` → `inferred` → `stated` → `confirmed` → `verified`
 */
export const ConfidenceLevelSchema = z.enum(['assumed', 'inferred', 'stated', 'confirmed', 'verified']);

/**
 * One piece of evidence contributing to the overall confidence of an artifact.
 *
 * Multiple bases can be accumulated for the same artifact revision as
 * additional actors review or verify it.
 */
export const ConfidenceBasisSchema = z.object({
  /** Basis kind, e.g. `'human-review'`, `'automated-test'`, `'source-reference'`. */
  kind: z.string().min(1),
  /** The actor that provided this basis. */
  actor: ArtifactActorSchema,
  /** Unix epoch timestamp (milliseconds) when this basis was recorded. */
  timestamp: z.number().int().nonnegative(),
  /** Optional free-text detail explaining the basis. */
  detail: z.string().optional(),
  /** Optional pointer to the source evidence. */
  evidenceRef: ArtifactRelationTargetSchema.optional(),
});

/**
 * Aggregated confidence metadata for an artifact revision.
 *
 * `basis` carries the ordered set of individual evidence entries that
 * together justify the overall `level`.
 */
export const ConfidenceMetadataSchema = z.object({
  /** Overall confidence level. */
  level: ConfidenceLevelSchema,
  /** Ordered list of individual evidence contributions. */
  basis: z.array(ConfidenceBasisSchema),
});

/**
 * A single typed observation attached to an artifact revision.
 *
 * Observations are append-only — they do not mutate the revision's `data`
 * but augment it with actor-sourced findings.
 */
export const ArtifactObservationSchema = z.object({
  /** Stable identifier for this observation within the owning revision. */
  id: z.string().min(1),
  /** Observation kind, e.g. `'lint-finding'`, `'review-comment'`. */
  kind: z.string().min(1),
  /** Short human-readable summary. */
  summary: z.string().min(1),
  /** Optional extended detail text. */
  detail: z.string().optional(),
  /** Optional severity classification. */
  severity: z.enum(['info', 'warning', 'blocker']).optional(),
  /** Optional free-form classification tags. */
  tags: z.array(z.string().min(1)).optional(),
  /** Optional reference to the artifact or sub-element this observation regards. */
  regarding: z.union([ArtifactRefSchema, LocalRefSchema]).optional(),
  /** Optional reference to the evidence backing this observation. */
  evidence: z.union([ArtifactRefSchema, EvidenceRefSchema]).optional(),
  /** Actor that produced this observation. */
  actor: ArtifactActorSchema,
  /** Unix epoch timestamp (milliseconds) when this observation was recorded. */
  timestamp: z.number().int().nonnegative(),
});

/**
 * Human-readable rendering hints for an artifact revision.
 *
 * All fields are optional — consumers may fall back to raw `data` when
 * none are provided.
 */
export const ArtifactRepresentationsSchema = z.object({
  /** Markdown-formatted representation. */
  markdown: z.string().optional(),
  /** One-sentence or one-paragraph summary. */
  summary: z.string().optional(),
  /** Plain-text representation. */
  plaintext: z.string().optional(),
});

/**
 * A complete, immutable artifact revision.
 *
 * Each write to the artifact store creates a new revision; the previous
 * revision is never mutated. Callers should use the generic {@link ArtifactRevision}
 * type alias when they need a strongly-typed `data` field.
 */
export const ArtifactRevisionSchema = z.object({
  /** Kind discriminator, matching a registered {@link ArtifactKindRegistrationSchema}. */
  kind: z.string().min(1),
  /** Stable artifact identity (unchanged across revisions). */
  id: z.string().min(1),
  /** Revision identifier (unique within the artifact's history). */
  revision: z.string().min(1),
  /** Scope at which this revision is relevant. */
  scope: ArtifactScopeSchema,
  /** Schema version used to interpret `data` (semver or opaque string). */
  schemaVersion: z.string().min(1),
  /** Kind-specific payload validated by the kind's `dataSchema`. */
  data: JsonObjectContractSchema,
  /** Typed links to other artifacts, sub-elements, or external evidence. */
  relations: z.array(ArtifactRelationSchema),
  /** Optional aggregated confidence metadata. */
  confidence: ConfidenceMetadataSchema.optional(),
  /** Optional human-readable rendering hints. */
  representations: ArtifactRepresentationsSchema.optional(),
  /** Actor that produced this revision. */
  actor: ArtifactActorSchema,
  /** Unix epoch timestamp (milliseconds) when this revision was recorded. */
  timestamp: z.number().int().nonnegative(),
  /** Unix epoch timestamp (milliseconds) when the artifact identity was first made current. */
  createdAt: z.number().int().nonnegative().optional(),
});

/**
 * Strategy used when two revisions of the same artifact conflict.
 *
 * - `supersedes` — newer revision wins; older is archived automatically
 * - `manual` — host must resolve the conflict explicitly
 * - `coexist` — both revisions are kept; conflict is surfaced to consumers
 */
export const ArtifactConflictPolicySchema = z.enum(['supersedes', 'manual', 'coexist']);

/**
 * Registration record for a named artifact kind.
 *
 * Kind registrations are declared by product extensions and consumed by the
 * artifact service to validate, index, and lifecycle-manage revisions of that kind.
 */
export const ArtifactKindRegistrationSchema = z.object({
  /** Unique kind string. Must be stable across releases. */
  kind: z.string().min(1),
  /** Schema version that `dataSchema` validates against. */
  schemaVersion: z.string().min(1),
  /** JSON Schema for the kind-specific `data` payload. */
  dataSchema: JsonObjectContractSchema,
  /** Optional JSON Schema for scope-identifying fields. */
  scopeSchema: JsonObjectContractSchema.optional(),
  /** Optional JSON Schema for kind-specific observation extensions. */
  observationSchema: JsonObjectContractSchema.optional(),
  /**
   * Field path(s) within `data` used to discriminate between instances
   * when multiple revisions of the same kind exist in the same scope.
   */
  discriminator: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  /** Conflict resolution strategy for this kind. */
  conflictPolicy: ArtifactConflictPolicySchema,
  /** Optional mapping from a `data` field to a set of known status values. */
  status: z
    .object({
      /** Dot-separated path to the status field within `data`. */
      path: z.string().min(1),
      /** Enumerated allowed values (open if omitted). */
      values: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Optional lifecycle hints for retention and decay. */
  lifecycle: z
    .object({
      /** Initial relevance classification on creation. */
      defaultRelevance: z.enum(['active', 'fading', 'retired', 'archived']).optional(),
      /** Opaque decay policy identifier understood by the artifact service. */
      decayPolicy: z.string().min(1).optional(),
    })
    .optional(),
  /** Field paths within `data` that should receive a secondary index. */
  indexedFields: z.array(z.string().min(1)).optional(),
  /** Field paths within `data` that should be included in full-text search. */
  searchableFields: z.array(z.string().min(1)).optional(),
});

/**
 * Registration record for a named relation type.
 *
 * Relation type registrations declare the semantics and valid endpoints
 * for a given relation `type` string.
 */
export const RelationTypeRegistrationSchema = z.object({
  /** Unique relation type string. Must be stable across releases. */
  type: z.string().min(1),
  /**
   * Whether the relation is directed or bidirectional.
   *
   * - `asymmetric` — source → target only
   * - `symmetric` — implies the inverse relation as well
   */
  symmetry: z.enum(['asymmetric', 'symmetric']),
  /**
   * Optional implication string: the reverse relation type to materialise
   * automatically when `symmetry` is `symmetric`.
   */
  implication: z.string().min(1).optional(),
  /** Artifact kinds valid as the source of this relation. Open if omitted. */
  sourceKinds: z.array(z.string().min(1)).optional(),
  /** Artifact kinds valid as the target of this relation. Open if omitted. */
  targetKinds: z.array(z.string().min(1)).optional(),
  /** Reference classes valid as relation targets. Open if omitted. */
  targetRefClasses: z.array(z.enum(['artifact', 'local', 'evidence'])).optional(),
});

/**
 * Query parameters for retrieving artifact revisions from the store.
 *
 * All fields are optional and composed with AND semantics; omitting a field
 * leaves that dimension unconstrained.
 */
export const ArtifactQueryRequestSchema = z.object({
  /** Restrict results to a single artifact kind. */
  kind: z.string().min(1).optional(),
  /** Restrict results to a specific scope. */
  scope: ArtifactQueryScopeSchema.optional(),
  /** Restrict results to specific artifact identifiers. */
  ids: z.array(z.string().min(1)).optional(),
  /** When `true`, return only the latest revision of each artifact. */
  currentOnly: z.boolean().optional(),
  /** Full-text search term matched against `searchableFields`. */
  search: z.string().optional(),
  /** Filter by the presence and target of a specific relation. */
  relation: z
    .object({
      /** Relation type to filter on. Omit to match any relation type. */
      type: z.string().min(1).optional(),
      /** Target the relation must point at. Omit to match any target. */
      target: ArtifactRelationTargetSchema.optional(),
    })
    .optional(),
  /** Filter by confidence level bounds. */
  confidence: z
    .object({
      /** Upper bound (inclusive) for confidence level. */
      maxLevel: ConfidenceLevelSchema.optional(),
      /** Lower bound (inclusive) for confidence level. */
      minLevel: ConfidenceLevelSchema.optional(),
    })
    .optional(),
  /** Filter by indexed field values within `data`. */
  indexed: z.record(z.string(), JsonValueSchema).optional(),
  /** Maximum number of results to return. */
  limit: z.number().int().min(1).optional(),
});

/**
 * Request to compare two artifact revisions.
 */
export const ArtifactCompareRequestSchema = z.object({
  /** Base revision for the comparison. */
  base: ArtifactRefSchema,
  /** Target revision to compare against the base. */
  target: ArtifactRefSchema,
});

/**
 * Result of comparing two artifact revisions.
 *
 * `changedPaths` lists the dot-separated paths within `data` that differ
 * between `base` and `target`.
 */
export const ArtifactCompareResponseSchema = z.object({
  /** The base revision. */
  base: ArtifactRevisionSchema,
  /** The target revision. */
  target: ArtifactRevisionSchema,
  /** Dot-separated `data` paths that changed between base and target. */
  changedPaths: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

/** Actor identity for artifact authorship and confidence attribution. */
export type ArtifactActor = z.infer<typeof ArtifactActorSchema>;

/** Scope descriptor for an artifact revision. */
export type ArtifactScope = z.infer<typeof ArtifactScopeSchema>;

/** Scope descriptor for artifact query filters. */
export type ArtifactQueryScope = z.infer<typeof ArtifactQueryScopeSchema>;

/** Immutable pointer to a specific artifact revision. */
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** Pointer to a named sub-element within a specific artifact revision. */
export type LocalRef = z.infer<typeof LocalRefSchema>;

/** Pointer to external evidence outside the artifact store. */
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Union of all valid relation-target reference classes. */
export type ArtifactRelationTarget = z.infer<typeof ArtifactRelationTargetSchema>;

/** A typed directional link from an artifact to a relation target. */
export type ArtifactRelation = z.infer<typeof ArtifactRelationSchema>;

/** Ordered confidence level for an artifact assertion. */
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

/** One piece of evidence contributing to overall artifact confidence. */
export type ConfidenceBasis = z.infer<typeof ConfidenceBasisSchema>;

/** Aggregated confidence metadata for an artifact revision. */
export type ConfidenceMetadata = z.infer<typeof ConfidenceMetadataSchema>;

/** A typed observation attached to an artifact revision. */
export type ArtifactObservation = z.infer<typeof ArtifactObservationSchema>;

/** Human-readable rendering hints for an artifact revision. */
export type ArtifactRepresentations = z.infer<typeof ArtifactRepresentationsSchema>;

/**
 * A complete, immutable artifact revision.
 *
 * The generic `TData` parameter narrows the `data` field to a specific
 * kind-validated shape, while defaulting to `Record<string, unknown>` for
 * untyped call sites.
 * @typeParam TData - Kind-specific payload type for the `data` field.
 */
export type ArtifactRevision<TData extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof ArtifactRevisionSchema>,
  'data'
> & {
  data: TData;
};

/** Conflict resolution strategy for an artifact kind. */
export type ArtifactConflictPolicy = z.infer<typeof ArtifactConflictPolicySchema>;

/** Registration record for a named artifact kind. */
export type ArtifactKindRegistration = z.infer<typeof ArtifactKindRegistrationSchema>;

/** Registration record for a named relation type. */
export type RelationTypeRegistration = z.infer<typeof RelationTypeRegistrationSchema>;

/** Query parameters for retrieving artifact revisions from the store. */
export type ArtifactQueryRequest = z.infer<typeof ArtifactQueryRequestSchema>;

/** Request to compare two artifact revisions. */
export type ArtifactCompareRequest = z.infer<typeof ArtifactCompareRequestSchema>;

/** Result of comparing two artifact revisions. */
export type ArtifactCompareResponse = z.infer<typeof ArtifactCompareResponseSchema>;

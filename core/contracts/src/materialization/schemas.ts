import { z } from 'zod';

import { JsonObjectContractSchema } from '../shared/json-value.js';
import { ArtifactViewAffordanceDeclarationSchema } from './view-builder.js';
import { ArtifactViewLevelSchema } from './view-model.js';

/** View role that a projected field may declare for view rendering. */
export const ProjectedFieldViewRoleSchema = z.enum(['title', 'summary']);

/**
 * Discriminated target that a surface binding maps to on the external provider.
 *
 * Each variant carries the fields required to identify the target element
 * on the provider surface:
 *
 * - `'label'` — a label or tag on the issue/work item (optional prefix filter)
 * - `'field'` — a named custom field on the work item (optional external field id)
 * - `'issue-type'` — a named issue type classification (optional external type id)
 * - `'body-fragment'` — a named slot in the issue or PR body
 * - `'comment'` — a structured comment rendered from a template string
 */
export const SurfaceBindingTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    /** Target kind discriminant. */
    kind: z.literal('label'),
    /** Optional label prefix filter (e.g. `'status/'`). */
    prefix: z.string().min(1).optional(),
  }),
  z.object({
    /** Target kind discriminant. */
    kind: z.literal('field'),
    /** Display name of the custom field on the provider. */
    name: z.string().min(1),
    /** Optional stable provider-assigned field identifier. */
    fieldId: z.string().min(1).optional(),
  }),
  z.object({
    /** Target kind discriminant. */
    kind: z.literal('issue-type'),
    /** Display name of the issue type on the provider. */
    name: z.string().min(1),
    /** Optional stable provider-assigned type identifier. */
    typeId: z.string().min(1).optional(),
  }),
  z.object({
    /** Target kind discriminant. */
    kind: z.literal('body-fragment'),
    /** Named slot in the body where this fragment is rendered. */
    slot: z.string().min(1),
  }),
  z.object({
    /** Target kind discriminant. */
    kind: z.literal('comment'),
    /** Handlebars-style template string for rendering the comment body. */
    template: z.string().min(1),
  }),
]);

/**
 * Serializable registration record for a surface binding.
 *
 * Surface binding registrations describe how a framework namespace maps to a
 * provider-specific surface element (field, label, issue type, etc.).
 * Registrations are declared by product extensions and consumed by
 * materialization adapters at sync time.
 *
 * The `id` field is a dot-namespaced stable string (e.g. `'github.status.field'`).
 */
export const SurfaceBindingRegistrationSchema = z.object({
  /**
   * Stable identifier for this surface binding.
   * Dot-namespaced by convention, e.g. `'github.status.field'`.
   */
  id: z.string().min(1),
  /** Provider identifier this binding targets (e.g. `'github'`, `'jira'`). */
  provider: z.string().min(1),
  /** Framework namespace identifier this binding covers (e.g. `'status'`). */
  namespace: z.string().min(1),
  /** Provider-side target element this namespace maps to. */
  target: SurfaceBindingTargetSchema,
  /**
   * Entity classes this binding applies to.
   * At least one entry is required.
   */
  appliesTo: z.array(z.enum(['workpiece', 'artifact', 'surface'])).min(1),
  /**
   * Optional mapping from framework namespace values to provider surface values.
   *
   * Keys are framework-side values; values are the corresponding provider-side
   * labels or identifiers. When absent the framework value is used verbatim.
   */
  valueMapping: z.record(z.string(), z.string()).optional(),
  /** Optional human-readable description of this surface binding. */
  description: z.string().min(1).optional(),
  /**
   * Optional JSON-safe runtime parameters for this binding.
   *
   * Parameters are JSON-safe objects validated at runtime. Builder authoring
   * narrows them through {@link ArtifactViewParamsFor}; this wire schema stays
   * open because it cannot know which artifact kind is requested.
   */
  params: JsonObjectContractSchema.optional(),
});

/** Serializable registration record for a surface binding. */
export type SurfaceBindingRegistration = z.infer<typeof SurfaceBindingRegistrationSchema>;

/** Discriminated target on the external provider surface. */
export type SurfaceBindingTarget = z.infer<typeof SurfaceBindingTargetSchema>;

/** Semantic hint for provider-neutral artifact projected fields. */
export const ProjectedFieldSemanticSchema = z.enum(['status', 'workflow', 'priority']);

/**
 * A provider-neutral field from artifact data that may be projected to an
 * external surface or used in view rendering.
 *
 * Extended fields for the view projection system:
 * - `fromLevel` — the minimum detail level at which this field becomes
 *   available. Levels order monotonically: `link < summary < full`. Omitted
 *   `fromLevel` means `full` during generic resolution.
 * - `viewRole` — declares whether this field serves as the artifact's display
 *   `title` or `summary` in rendered views. At most one of each role may be
 *   declared per artifact kind.
 */
export const ProjectedFieldSchema = z.object({
  /** Dot-separated path into artifact.data, such as `status` or `metadata.priority`. */
  path: z.string().min(1),
  /** Optional semantic hint used by provider-specific materializers. */
  semantic: ProjectedFieldSemanticSchema.optional(),
  /**
   * Minimum detail level at which this field becomes available.
   * Omitted `fromLevel` means `full` during generic resolution.
   */
  fromLevel: ArtifactViewLevelSchema.optional(),
  /**
   * View role declaration for this field.
   * At most one `title` and one `summary` role may be declared per kind.
   */
  viewRole: ProjectedFieldViewRoleSchema.optional(),
});

/** Semantic hint for provider-neutral artifact projected fields. */
export type ProjectedFieldSemantic = z.infer<typeof ProjectedFieldSemanticSchema>;

/** View role for a projected field. */
export type ProjectedFieldViewRole = z.infer<typeof ProjectedFieldViewRoleSchema>;

/** A provider-neutral artifact field projection declaration. */
export type ProjectedField = z.infer<typeof ProjectedFieldSchema>;

/**
 * Projection policy that controls how an artifact kind surfaces on a provider.
 *
 * - `'none'` — the artifact is never materialized to a provider surface
 * - `'surface'` — the artifact maps to a provider work item or issue
 * - `'comment'` — the artifact is rendered as a structured comment on an existing item
 */
export const ArtifactProjectionPolicySchema = z
  .object({
    /** Materialization mode for this artifact kind. */
    mode: z.enum(['none', 'surface', 'comment']),
    /**
     * Default surface role when the artifact is materialized.
     * - `'workpiece'` — the artifact is the primary tracked item
     * - `'artifact'` — the artifact is a secondary record attached to a workpiece
     */
    defaultRole: z.enum(['workpiece', 'artifact']).optional(),
    /**
     * Semantic events that trigger a re-sync of the artifact to the provider surface.
     * When absent all events trigger a sync.
     */
    semanticEvents: z.array(z.enum(['created', 'revised', 'status-changed', 'observation-added'])).optional(),
    /**
     * Provider-neutral artifact data fields that materializers may map to external
     * issue fields or equivalent structured provider surfaces.
     */
    projectedFields: z.array(ProjectedFieldSchema).optional(),
    /**
     * Affordance declarations controlling where and how this artifact kind may
     * be rendered as a view.
     *
     * When present, affordances are exact and authoritative — only declared
     * affordances are available. When absent, legacy defaults apply based on
     * the projection mode. An empty array means the kind renders nowhere.
     */
    affordances: z.array(ArtifactViewAffordanceDeclarationSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.projectedFields) return;

    let titleCount = 0;
    let summaryCount = 0;

    for (const field of val.projectedFields) {
      if (field.viewRole === 'title') titleCount++;
      if (field.viewRole === 'summary') summaryCount++;
    }

    if (titleCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectedFields'],
        message: 'At most one projected field may declare viewRole: title',
      });
    }
    if (summaryCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectedFields'],
        message: 'At most one projected field may declare viewRole: summary',
      });
    }
  });

/** Projection policy that controls how an artifact kind surfaces on a provider. */
export type ArtifactProjectionPolicy = z.infer<typeof ArtifactProjectionPolicySchema>;

/**
 * A reference linking a framework artifact to an external provider object.
 *
 * `artifactId` and `provider`+`externalId` together form the composite primary
 * key for a materialization ref. The `surfaceRole` captures whether the artifact
 * was materialized as the top-level workpiece or as a subordinate artifact record.
 */
export const ArtifactMaterializationRefSchema = z.object({
  /** Stable framework artifact identity. */
  artifactId: z.string().min(1),
  /** Provider identifier (e.g. `'github'`, `'jira'`). */
  provider: z.string().min(1),
  /** Provider-assigned stable object identifier (e.g. a GitHub node ID). */
  externalId: z.string().min(1),
  /** Optional deep-link URL to the provider object. */
  externalUrl: z.string().optional(),
  /** Surface role the artifact occupies on the provider. */
  surfaceRole: z.enum(['workpiece', 'artifact']),
  /** Artifact revision that was last successfully synced to this provider object. */
  lastSyncedRevision: z.string().optional(),
  /** Provider-specific metadata snapshot (e.g. owner, repo, issue number). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** A reference linking a framework artifact to an external provider object. */
export type ArtifactMaterializationRef = z.infer<typeof ArtifactMaterializationRefSchema>;

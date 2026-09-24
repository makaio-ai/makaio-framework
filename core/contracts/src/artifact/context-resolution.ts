import { z } from 'zod';
import { ArtifactContextRelationDirectionSchema, ArtifactContextRenderHintSchema } from './context-selectors.js';
import {
  ArtifactRefSchema,
  ArtifactRelationSchema,
  ArtifactRelationTargetSchema,
  ArtifactRevisionSchema,
} from './schemas.js';

interface ArtifactRevisionKeyFields {
  /** Artifact kind discriminator. */
  kind: string;
  /** Stable artifact identity. */
  id: string;
  /** Artifact revision identity. */
  revision: string;
}

/**
 * Creates a collision-safe key identifying one artifact revision.
 *
 * The key is the JSON encoding of the `[kind, id, revision]` tuple, so field
 * values containing separator characters cannot collide. Use it wherever
 * artifact refs must be matched against revision payloads (for example the
 * `resolved` pool of a {@link ResolvedArtifactContextWire}) so producers and
 * readers of the context wire format agree on revision identity.
 * @param ref - Artifact reference or revision fields to identify; only `kind`, `id`, and `revision` are read.
 * @returns Stable key for the artifact revision identity.
 */
export function artifactRevisionKey(ref: ArtifactRevisionKeyFields): string {
  return JSON.stringify([ref.kind, ref.id, ref.revision]);
}

/**
 * Reasons why a relation target was not resolved during context resolution.
 *
 * v1 omits `scope-denied` -- no scope policy seam exists yet.
 */
export const ArtifactContextUnresolvedReasonSchema = z.enum([
  'not-selected',
  'not-found',
  'depth-exceeded',
  'unsupported-ref-class',
  'cycle-detected',
]);

/** An unresolved reason for a context ref entry. */
export type ArtifactContextUnresolvedReason = z.infer<typeof ArtifactContextUnresolvedReasonSchema>;

/**
 * A single entry in the normalized artifact context wire format.
 *
 * Each entry records one traversal edge from the walked artifact
 * (`sourceRef`) to a `target`, along with resolution status and the render
 * hint used. For the default outbound direction the edge is the stored
 * relation itself. For an inbound edge the stored relation lives on the
 * target and points back at `sourceRef`'s identity; `direction` marks this.
 */
export const ArtifactContextRefEntrySchema = z
  .object({
    /** The relation target reference. */
    target: ArtifactRelationTargetSchema,
    /** The walked artifact this edge starts from. */
    sourceRef: ArtifactRefSchema,
    /** The relation type string. */
    relationType: z.string().min(1),
    /** Optional local identifier of the part that owns the stored relation. */
    sourceLocalId: ArtifactRelationSchema.shape.sourceLocalId,
    /**
     * Direction of the stored relation relative to the edge; absent means outbound.
     * Producers omit the field for outbound edges; readers must treat an absent
     * value and `'outbound'` alike.
     */
    direction: ArtifactContextRelationDirectionSchema.optional(),
    /** The render hint applied to this entry. */
    hint: ArtifactContextRenderHintSchema,
    /** Whether the target was successfully resolved. */
    status: z.enum(['resolved', 'unresolved']),
    /** Reason for non-resolution (required when status is unresolved). */
    reason: ArtifactContextUnresolvedReasonSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.status === 'unresolved' && entry.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason is required for unresolved artifact context refs',
      });
    }
    if (entry.status === 'resolved' && entry.reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason must be omitted for resolved artifact context refs',
      });
    }
    if (entry.status === 'resolved' && entry.target.refClass !== 'artifact') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target'],
        message: 'resolved artifact context refs must target an artifact revision',
      });
    }
  });

/** A single resolved or unresolved context ref entry. */
export type ArtifactContextRefEntry = z.infer<typeof ArtifactContextRefEntrySchema>;

/**
 * Normalized wire format for a resolved artifact context graph.
 *
 * Contains the root artifact reference, all encountered relation entries
 * (both resolved and unresolved), and the pool of resolved artifact
 * revisions referenced by the entries.
 */
export const ResolvedArtifactContextWireSchema = z
  .object({
    /** The root artifact reference that resolution started from. */
    rootRef: ArtifactRefSchema,
    /** All encountered relation entries in traversal order. */
    refs: z.array(ArtifactContextRefEntrySchema),
    /** Pool of resolved artifact revisions referenced by entries. */
    resolved: z.array(ArtifactRevisionSchema),
  })
  .superRefine((wire, ctx) => {
    const resolvedRevisionKeys = new Set(wire.resolved.map(artifactRevisionKey));

    if (!resolvedRevisionKeys.has(artifactRevisionKey(wire.rootRef))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resolved'],
        message: 'resolved artifact context wire payloads must include the root artifact revision',
      });
    }

    wire.refs.forEach((entry, index) => {
      if (!resolvedRevisionKeys.has(artifactRevisionKey(entry.sourceRef))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['refs', index, 'sourceRef'],
          message: 'artifact context ref sources must have a matching revision in resolved',
        });
      }

      if (entry.status !== 'resolved' || entry.target.refClass !== 'artifact') {
        return;
      }

      if (!resolvedRevisionKeys.has(artifactRevisionKey(entry.target))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['refs', index, 'target'],
          message: 'resolved artifact context refs must have a matching revision in resolved',
        });
      }
    });
  });

/** Normalized wire format for a resolved artifact context graph. */
export type ResolvedArtifactContextWire = z.infer<typeof ResolvedArtifactContextWireSchema>;

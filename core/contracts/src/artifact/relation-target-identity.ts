import { z } from 'zod';

import type { ArtifactRelationTarget } from './schemas.js';

/**
 * Pin-less identity of a relation target.
 *
 * The schema is the authoritative definition of what uniqueness comparisons
 * operate on: an `artifact` target is identified by its kind and stable id
 * only (the mutable revision pin is excluded), and an `entity` target is
 * identified by its entity type and id.
 *
 * Local and evidence targets carry no comparable stable identity and are
 * therefore excluded from this union.
 */
export const ArtifactRelationTargetIdentitySchema = z.discriminatedUnion('refClass', [
  z.strictObject({
    /** Literal reference class. Always `'artifact'`. */
    refClass: z.literal('artifact'),
    /** Kind discriminator, matching the registered artifact kind. */
    kind: z.string().min(1),
    /** Stable artifact identity (does not change across revisions). */
    id: z.string().min(1),
  }),
  z.strictObject({
    /** Literal reference class. Always `'entity'`. */
    refClass: z.literal('entity'),
    /** Entity type understood by the owning service. */
    entityType: z.string().min(1),
    /** Stable identity within that entity type. */
    id: z.string().min(1),
  }),
]);

/**
 * Pin-less identity of a relation target.
 * @see {@link ArtifactRelationTargetIdentitySchema}
 */
export type ArtifactRelationTargetIdentity = z.infer<typeof ArtifactRelationTargetIdentitySchema>;

/**
 * Strip the revision pin from an artifact target and keep an entity target as
 * is, producing the comparable pin-less identity for uniqueness checks.
 * @param target - A parsed {@link ArtifactRelationTarget}.
 * @returns The pin-less {@link ArtifactRelationTargetIdentity} for `artifact`
 *   and `entity` targets, or `undefined` for `local` and `evidence` targets
 *   which carry no stable comparable identity.
 */
export function artifactRelationTargetIdentity(
  target: ArtifactRelationTarget,
): ArtifactRelationTargetIdentity | undefined {
  if (target.refClass === 'artifact') {
    return { refClass: 'artifact', kind: target.kind, id: target.id };
  }
  if (target.refClass === 'entity') {
    return { refClass: 'entity', entityType: target.entityType, id: target.id };
  }
  return undefined;
}

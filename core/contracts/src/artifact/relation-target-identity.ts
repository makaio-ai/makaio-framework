import { z } from 'zod';

import { ArtifactRefSchema } from './artifact-reference.js';
import type { ArtifactRelationTarget } from './schemas.js';
import { EntityRefSchema } from './schemas.js';

/**
 * Pin-less identity of a relation target.
 *
 * The schema is derived from the canonical ref schemas so validation cannot
 * drift from the definitions of what constitutes a valid artifact or entity
 * reference: an `artifact` target is identified by its kind and stable id
 * only (the mutable revision pin is omitted), and an `entity` target is
 * identified by its entity type and id.
 *
 * Local and evidence targets carry no comparable stable identity and are
 * therefore excluded from this union.
 */
export const ArtifactRelationTargetIdentitySchema = z.discriminatedUnion('refClass', [
  ArtifactRefSchema.omit({ revision: true }),
  EntityRefSchema,
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

/**
 * Injective string form of an identity; equal identities serialize equally,
 * distinct ones never collide.
 *
 * The serialization is a JSON-stringified fixed-order tuple:
 * `['artifact', kind, id]` for artifact targets or
 * `['entity', entityType, id]` for entity targets.
 * @param identity - A validated {@link ArtifactRelationTargetIdentity}.
 * @returns A stable, unique string for the identity.
 */
export function serializeArtifactRelationTargetIdentity(identity: ArtifactRelationTargetIdentity): string {
  if (identity.refClass === 'artifact') {
    return JSON.stringify(['artifact', identity.kind, identity.id]);
  }
  return JSON.stringify(['entity', identity.entityType, identity.id]);
}

/**
 * Human-readable form of an identity.
 * @param identity - A validated {@link ArtifactRelationTargetIdentity}.
 * @returns `artifact:<kind>/<id>` for artifact targets or
 *   `entity:<entityType>/<id>` for entity targets.
 */
export function describeArtifactRelationTargetIdentity(identity: ArtifactRelationTargetIdentity): string {
  if (identity.refClass === 'artifact') {
    return `artifact:${identity.kind}/${identity.id}`;
  }
  return `entity:${identity.entityType}/${identity.id}`;
}

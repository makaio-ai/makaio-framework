import { z } from 'zod';

/** A nonblank reference identity that remains enforceable in JSON Schema. */
const ArtifactReferenceIdentitySchema = z.string().min(1).regex(/\S/);

/**
 * An immutable pointer to a specific revision of an artifact.
 *
 * Kind, identity, and revision together uniquely identify a persisted snapshot
 * and are safe to store as foreign keys. The literal reference class prevents
 * structurally similar external evidence references from being accepted as
 * artifact pins.
 */
export const ArtifactRefSchema = z.strictObject({
  /** Literal reference class. Always `'artifact'`. */
  refClass: z.literal('artifact'),
  /** Kind discriminator, matching the registered artifact kind. */
  kind: ArtifactReferenceIdentitySchema,
  /** Stable artifact identity (does not change across revisions). */
  id: ArtifactReferenceIdentitySchema,
  /** Revision identifier (e.g. nanoid or monotone counter). */
  revision: ArtifactReferenceIdentitySchema,
});

/** Immutable pointer to a specific artifact revision. */
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

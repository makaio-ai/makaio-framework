import { z } from 'zod';
import { ArtifactResolvePartErrorSchema } from './artifact-parts.js';
import { ArtifactDataPathSchema } from './kind-registration.js';
import { LocalRefSchema } from './schemas.js';
import { JsonObjectContractSchema } from '../shared/json-value.js';

/**
 * Bus contract for `artifact.resolvePart`.
 *
 * Lives apart from artifact-parts.ts because the request and response embed
 * {@link LocalRefSchema}: schemas.ts depends on kind-registration.ts, which
 * depends on artifact-parts.ts for declaration validation, so referencing
 * schemas.ts from artifact-parts.ts would close an import cycle and leave
 * these schemas built from uninitialized bindings.
 */

/** Request payload for resolving one addressable artifact part. */
export const ArtifactResolvePartRequestSchema = z.object({
  /** Local reference identifying the artifact revision and the part within it. */
  ref: LocalRefSchema,
});

/** Request payload for resolving one addressable artifact part. */
export type ArtifactResolvePartRequest = z.infer<typeof ArtifactResolvePartRequestSchema>;

/**
 * Response payload for a part-resolution request.
 *
 * Outcomes are delivered in-band through an `ok` discriminant rather than
 * out-of-band error channels. This guarantees that the `repair` hint in a
 * rejection reaches callers regardless of which transport facade or middleware
 * layer is in use. Follows the same in-band contract established by the patch
 * response schema in patch.ts.
 */
export const ArtifactResolvePartResponseSchema = z.union([
  z.strictObject({
    /** Resolution succeeded. */
    ok: z.literal(true),
    /**
     * Normalized, revision-pinned local reference the part was resolved from.
     * The `artifact` field carries the exact revision, so callers can pin
     * future requests to this revision for deterministic re-resolution.
     */
    ref: LocalRefSchema,
    /** Data-relative path of the declared area the part was found in. */
    areaPath: ArtifactDataPathSchema,
    /** Verbatim part data from the pinned revision. */
    part: JsonObjectContractSchema,
  }),
  z.strictObject({
    /** Resolution failed. */
    ok: z.literal(false),
    /** Structured rejection with stable code and repair hint. */
    error: ArtifactResolvePartErrorSchema,
  }),
]);

/** Response payload for a part-resolution request. */
export type ArtifactResolvePartResponse = z.infer<typeof ArtifactResolvePartResponseSchema>;

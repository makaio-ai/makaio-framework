import { z } from 'zod';
import { ExtensionNameSchema } from '@makaio/core';
import type { ExtensionName } from '@makaio/core';

/**
 * Reference to an object in an external system.
 *
 * The identity of the object is `extension`, `site`, `objectType` and
 * `externalId` only. `parent` and `url` are not part of it.
 */
export interface ExternalObjectRef {
  /** Extension that owns the external system. */
  extension: ExtensionName;
  /** Site inside the external system (for example an organisation or a workspace). */
  site: string;
  /** Type of the object in the external system. */
  objectType: string;
  /** Identifier of the object, assigned by the external system. */
  externalId: string;
  /** Reference to the parent object, when the object lives below another one. Not part of the identity. */
  parent?: ExternalObjectRef | undefined;
  /** Address of the object for humans. Not part of the identity. */
  url?: string | undefined;
}

/**
 * Longest `parent` chain {@link ExternalObjectRefSchema} accepts, counted in
 * `ExternalObjectRef` levels including the object itself. A chain one level
 * longer, or one that revisits an object (a cycle), fails validation.
 */
export const EXTERNAL_OBJECT_REF_MAX_DEPTH = 16;

/**
 * Tells whether `value` is a non-null object, so its `parent` property, if
 * any, can be read without assuming the rest of its shape.
 * @param value - The value to narrow.
 * @returns Whether `value` can carry a `parent` property.
 */
function isObjectWithParent(value: unknown): value is { parent?: unknown } {
  return typeof value === 'object' && value !== null;
}

/**
 * Walks the `parent` chain of a candidate {@link ExternalObjectRef} once,
 * iteratively, to tell whether it contains a cycle (the same object reached
 * twice) or is longer than {@link EXTERNAL_OBJECT_REF_MAX_DEPTH}. Runs before
 * the recursive object schema, so that a cyclic or excessively deep chain
 * fails as an ordinary validation issue instead of overflowing the call stack.
 * @param candidate - The value to inspect; not yet known to be an {@link ExternalObjectRef}.
 * @returns Whether the `parent` chain is cyclic or exceeds the depth limit.
 */
function hasInvalidParentChain(candidate: unknown): boolean {
  const visited = new Set<unknown>();
  let current = candidate;
  let depth = 0;

  while (isObjectWithParent(current)) {
    if (visited.has(current)) {
      return true;
    }
    visited.add(current);
    depth += 1;
    if (depth > EXTERNAL_OBJECT_REF_MAX_DEPTH) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

/**
 * Cheap guard that rejects a cyclic or overly deep `parent` chain before any
 * recursive descent. In zod 4, a failed left side of `.pipe` short-circuits
 * without running the right side (`handlePipeResult` in
 * `zod/src/v4/core/schemas.ts` aborts on issues), so the recursive object
 * schema below never sees a cyclic or overlong chain.
 */
const ExternalObjectRefDepthGuardSchema = z.unknown().refine((value) => !hasInvalidParentChain(value), {
  message: `parent chain must not contain a cycle and must not exceed ${EXTERNAL_OBJECT_REF_MAX_DEPTH} levels`,
});

/**
 * Schema of {@link ExternalObjectRef}.
 *
 * Recursive through `parent`; the recursion uses `z.lazy` with an explicit
 * type annotation, as the other recursive schemas of the contracts do. Piped
 * behind {@link ExternalObjectRefDepthGuardSchema}, which rejects a cyclic or
 * overly deep `parent` chain before the recursive descent runs. The pipe's
 * left side accepts `unknown`; the declared input type stays
 * {@link ExternalObjectRef}, the shape callers pass and documentation shows,
 * because the guard only adds a runtime check and never transforms the value.
 */
export const ExternalObjectRefSchema: z.ZodType<ExternalObjectRef, ExternalObjectRef> =
  ExternalObjectRefDepthGuardSchema.pipe(
    z
      .object({
        /** Extension that owns the external system. */
        extension: ExtensionNameSchema,
        /** Site inside the external system. */
        site: z.string().min(1),
        /** Type of the object in the external system. */
        objectType: z.string().min(1),
        /** Identifier of the object, assigned by the external system. */
        externalId: z.string().min(1),
        /** Reference to the parent object. Not part of the identity. */
        parent: z.lazy(() => ExternalObjectRefSchema).optional(),
        /** Address of the object for humans. Not part of the identity. */
        url: z.string().optional(),
      })
      .strict(),
  ) as z.ZodType<ExternalObjectRef, ExternalObjectRef>;

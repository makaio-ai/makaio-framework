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

/** Single issue message for every way {@link readParentChain} can reject a candidate. */
const PARENT_CHAIN_ISSUE_MESSAGE =
  `parent chain must not contain a cycle, must not exceed ${EXTERNAL_OBJECT_REF_MAX_DEPTH} levels, ` +
  'and each level must be a plain object of own data properties';

/** One level of a `parent` chain, copied onto a plain object the guard owns. */
type ExternalObjectRefLevelCopy = Record<string, unknown>;

/**
 * Creates a fresh, empty object with a `null` prototype for a copy of one
 * `parent` chain level. A `null` prototype keeps every assignment and read on
 * the copy off `Object.prototype`, so a setter or getter a caller polluted
 * `Object.prototype` with (for an accepted key such as `extension` or `url`)
 * never runs while {@link copyLevel} builds the copy or zod later reads it.
 * Zod builds its parse result on an ordinary object and assigns every
 * validated field to it, as it does for every object schema, so a setter
 * installed on `Object.prototype` itself still runs there; a polluted global
 * prototype is outside what a schema can guard. The single `as` cast is unavoidable: `Object.create(null)` returns `any`,
 * and there is no cast-free way to narrow it to {@link ExternalObjectRefLevelCopy}.
 * @returns A new, empty, `null`-prototype object.
 */
function createNullProtoCopy(): ExternalObjectRefLevelCopy {
  return Object.create(null) as ExternalObjectRefLevelCopy;
}

/**
 * Copies the own enumerable data properties of one level of a candidate
 * `parent` chain onto a fresh plain object, or reports that the level cannot
 * be copied safely. The copy has a `null` prototype ({@link createNullProtoCopy}),
 * so a key the caller accepts (for example `extension` or `url`) never resolves
 * through a polluted `Object.prototype` when this function assigns it or zod
 * later reads it.
 *
 * Mirrors the prototype and accessor rules `isCallClaim` from `@makaio/core`
 * applies to a plain object: the prototype must be `Object.prototype` or
 * `null`, every own key must be a non-symbol string other than `__proto__`,
 * and every own property must be a non-accessor, enumerable data property.
 * Reading each key through `Object.getOwnPropertyDescriptor` detects a
 * `get`/`set` accessor without invoking it, so copying a level never runs a
 * property getter of the reference. No own value may be a function, `parent` included: zod's
 * result handling reflects on a value it receives (`instanceof Promise`), so a
 * callable Proxy reaching it would run a caller-owned trap. Every own value
 * other than `parent` must additionally be a primitive (`typeof` is neither
 * `'object'` nor `'function'`; `null` counts as primitive): the schema below
 * hands the copy to zod, whose invalid-type formatter inspects a rejected
 * value, so an object-valued non-`parent` field could still run a
 * caller-owned getter (for example on `constructor`) after copying.
 * Rejecting it here means the guard never reads into it at all. All
 * reflection used to inspect `value` (`Object.getPrototypeOf`,
 * `Reflect.ownKeys`, `Object.getOwnPropertyDescriptor`) can itself throw —
 * for a revoked Proxy, or a Proxy whose trap throws — so every reflective
 * step runs inside a single `try`/`catch` that treats any failure as "not
 * copyable", the only `try`/`catch` in this function. The traps of a Proxy
 * (and accessors on its handler) are caller code and may run during this
 * reflection; under the default parse options that is the only place caller
 * code can run during validation. With `reportInput: true`, zod itself
 * attaches the caller's input to each issue and serializes it into the error
 * message, which this guard does not control.
 * @param value - Candidate level to copy.
 * @returns The copy, or `undefined` when the level is not copyable.
 */
function copyLevel(value: unknown): ExternalObjectRefLevelCopy | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return undefined;
    }
    const copy: ExternalObjectRefLevelCopy = createNullProtoCopy();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol' || key === '__proto__') {
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        return undefined;
      }
      const leaf: unknown = descriptor.value;
      if (typeof leaf === 'function' || (key !== 'parent' && typeof leaf === 'object' && leaf !== null)) {
        return undefined;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return undefined;
  }
}

/**
 * Reads the `parent` chain of a candidate {@link ExternalObjectRef} once,
 * iteratively, copying each level's own enumerable data properties onto a
 * plain object the guard owns (see {@link copyLevel}), and linking each copy's
 * `parent` to the next copy. Also rejects a chain that contains a cycle (the
 * same object reached twice) or exceeds {@link EXTERNAL_OBJECT_REF_MAX_DEPTH}
 * levels. Runs before the recursive object schema, reading the caller's
 * object exactly once; the recursive schema afterwards only ever reads the
 * returned copy, whose own values other than `parent` are all primitives
 * (see {@link copyLevel}), never the caller's object again, so a stateful
 * `parent` getter cannot answer a second read differently from the first,
 * and zod's own reflection (for example its invalid-type formatter) cannot
 * run a caller-owned getter either. Under the default parse options, caller
 * code can run only as Proxy traps during the caught reflection in
 * {@link copyLevel} (see there for `reportInput`). Every returned copy has a
 * `null` prototype ({@link createNullProtoCopy}), so the recursive schema
 * below never reads a caller-polluted `Object.prototype`.
 * @param candidate - The value to inspect; not yet known to be an {@link ExternalObjectRef}.
 * @param ctx - The transform context the schema below reports issues to.
 * @returns The copied top-level object (with a copied `parent` chain), the
 *   original `candidate` unchanged when it is a primitive (so the recursive
 *   schema reports its own type-mismatch issue), or {@link z.NEVER} after
 *   reporting an issue for a function (including a callable Proxy, which zod
 *   would otherwise reflect on) or a cyclic, overly deep, or unsafe-to-copy
 *   chain.
 */
function readParentChain(candidate: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof candidate === 'function') {
    ctx.addIssue({ code: 'custom', message: PARENT_CHAIN_ISSUE_MESSAGE });
    return z.NEVER;
  }
  if (typeof candidate !== 'object' || candidate === null) {
    return candidate;
  }

  const visited = new Set<unknown>();
  let current: unknown = candidate;
  let topCopy: ExternalObjectRefLevelCopy | undefined;
  let previousCopy: ExternalObjectRefLevelCopy | undefined;
  let depth = 0;

  while (typeof current === 'object' && current !== null) {
    if (visited.has(current)) {
      ctx.addIssue({ code: 'custom', message: PARENT_CHAIN_ISSUE_MESSAGE });
      return z.NEVER;
    }
    visited.add(current);
    depth += 1;
    if (depth > EXTERNAL_OBJECT_REF_MAX_DEPTH) {
      ctx.addIssue({ code: 'custom', message: PARENT_CHAIN_ISSUE_MESSAGE });
      return z.NEVER;
    }

    const copy = copyLevel(current);
    if (copy === undefined) {
      ctx.addIssue({ code: 'custom', message: PARENT_CHAIN_ISSUE_MESSAGE });
      return z.NEVER;
    }

    topCopy ??= copy;
    if (previousCopy !== undefined) {
      previousCopy.parent = copy;
    }
    previousCopy = copy;
    current = copy.parent;
  }

  return topCopy;
}

/**
 * Schema of {@link ExternalObjectRef}.
 *
 * Recursive through `parent`; the recursion uses `z.lazy` with an explicit
 * type annotation, as the other recursive schemas of the contracts do.
 * Preceded by a transform ({@link readParentChain}) that reads the `parent`
 * chain once into a flat structure of plain, null-prototype copies and
 * rejects a cyclic, overly deep, or unsafe-to-copy chain with an ordinary zod
 * issue; the recursive object schema afterwards only ever validates that
 * copy, whose own values other than `parent` are all primitives (see
 * {@link copyLevel}), so zod — including its invalid-type formatter, which
 * inspects a rejected value's properties — never reads a caller-owned object
 * or function under the default parse options (with `reportInput: true` zod
 * attaches and serializes the caller's input itself; see {@link copyLevel}).
 * In zod 4, a failed left side of `.pipe` short-circuits without running the
 * right side (`handlePipeResult` in `zod/src/v4/core/schemas.ts` aborts on
 * issues), so the recursive object schema never sees a rejected chain. The
 * pipe's left side accepts `unknown`; the declared input type stays
 * {@link ExternalObjectRef}, the shape callers pass and documentation shows,
 * because a successfully parsed value is always structurally identical to
 * what the caller passed in, only backed by the guard's own, safe-to-reread
 * copy instead of the caller's object.
 */
export const ExternalObjectRefSchema: z.ZodType<ExternalObjectRef, ExternalObjectRef> = z
  .unknown()
  .transform(readParentChain)
  .pipe(
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

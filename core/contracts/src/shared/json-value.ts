import { z } from 'zod';

/**
 * JSON-safe value type shared by storage and runtime context contracts.
 *
 * Restricting persisted values to JSON keeps the storage contracts aligned
 * with the actual serialization boundary instead of accepting runtime-only
 * values such as functions, Maps, or `undefined`.
 *
 * The object branch intentionally stays broad (`object`) instead of requiring
 * an index signature. The runtime Zod schema remains the source of truth for
 * JSON validation, while the broader TypeScript type keeps regular DTOs and
 * typed fixtures assignable without forcing every interface in the codebase to
 * declare `[key: string]: ...`.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | object;

/**
 * Recursive JSON-safe value schema.
 *
 * Uses `z.lazy()` so arrays and objects can reference the same schema without
 * widening the contract to arbitrary `unknown`.
 */
export const JsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.lazy(
  (): z.ZodType<JsonValue, JsonValue> =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
);

/**
 * Structural reason a raw value cannot cross a JSON boundary unchanged.
 *
 * - `prototype-key`: a `__proto__` own key the record parse drops instead of
 *   copying onto the output object.
 * - `non-plain-object`: an object the record parse would rebuild from its own
 *   enumerable string-keyed fields alone, which is not what the value is.
 * - `symbol-key`: an own symbol-keyed property that neither the record parse
 *   nor the array rebuild includes, since JSON has no symbol representation.
 *   The {@link JsonFidelityViolation.path} ends at the containing object —
 *   a symbol cannot appear in a JSON path.
 * - `non-enumerable-key`: a non-enumerable own string property that
 *   `Object.entries` skips, so the rebuilt record omits the key entirely.
 *   The {@link JsonFidelityViolation.path} extends to the key name so the
 *   caller knows exactly which property was hidden.
 * - `extra-array-key`: an own string property on an array beyond its canonical
 *   array indices and `length`. `z.array()` rebuilds from indexed elements only,
 *   so the property is silently dropped. The path extends to the property name.
 * - `cyclic-reference`: the object graph cannot be represented by a finite JSON
 *   tree. Repeated references outside the current ancestor chain are valid and
 *   copied into the detached tree independently.
 * - `nesting-too-deep`: the JSON tree exceeds the finite container nesting the
 *   boundary can inspect without unbounded recursion.
 * - `negative-zero`: JavaScript's `-0` would cross a JSON wire as `0`, so it is
 *   not a value the boundary can reproduce unchanged.
 * - `unreadable-value`: inspecting an object or evaluating one of its enumerable
 *   accessors threw, so no stable boundary snapshot can be produced.
 */
export type JsonFidelityViolationKind =
  | 'prototype-key'
  | 'non-plain-object'
  | 'symbol-key'
  | 'non-enumerable-key'
  | 'extra-array-key'
  | 'cyclic-reference'
  | 'nesting-too-deep'
  | 'negative-zero'
  | 'unreadable-value';

/** Where a raw value stops being reproducible, and why. */
export interface JsonFidelityViolation {
  /** What about the value cannot be reproduced. */
  readonly kind: JsonFidelityViolationKind;
  /** Path from the inspected root to the offending value; empty when it is the root. */
  readonly path: readonly (string | number)[];
}

/** A detached JSON-tree snapshot, or the first reason it could not be made. */
export type JsonBoundarySnapshot =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly violation: JsonFidelityViolation };

/**
 * Largest value an ECMAScript array index can take.
 *
 * An array index is defined as a canonical numeric string whose value is below
 * `2**32 - 1`, so the last usable index is one less than that — `2**32 - 1`
 * itself is the maximum *length*, never a position. A property named for it is
 * an ordinary string key that leaves `length` untouched, which is exactly why
 * the array rebuild drops it.
 */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * Maximum number of nested arrays and records accepted at a JSON boundary.
 *
 * The root container counts as one. A tree with 128 nested containers is
 * accepted; its 129th container is rejected before it is inspected further.
 */
export const JSON_BOUNDARY_MAX_CONTAINER_NESTING = 128;

/**
 * Decide whether an own property name of an array is one of its element slots.
 *
 * `z.array()` rebuilds from element slots alone, so this is the line between a
 * key that survives the rebuild and one that vanishes. A digits-only test is not
 * that line: `"01"` and `"4294967295"` are both digits-only, yet neither is an
 * array index — the first is not the canonical spelling of `1`, and the second
 * is the maximum array *length* rather than a position — so both are ordinary
 * string keys that the rebuild silently drops.
 *
 * Canonicality is decided by round-tripping through `Number`, which rejects
 * leading zeros, signs, whitespace, and exponent forms in one step. The integer
 * and range tests are what the round-trip alone does not cover: `"0.5"`
 * round-trips, and so does every canonical integer above the index ceiling.
 * @param key - Own string property name observed on an array.
 * @returns `true` when the key names an element slot the array rebuild preserves.
 */
function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index <= MAX_ARRAY_INDEX && String(index) === key;
}

type JsonBoundaryPath = readonly (string | number)[];

interface BoundaryObjectDescription {
  readonly isArray: boolean;
  readonly descriptors: ReadonlyMap<string, PropertyDescriptor>;
}

type SnapshotFailure = Extract<JsonBoundarySnapshot, { readonly ok: false }>;

/**
 * Narrow an inspection result to its rejected branch.
 * @param value - Snapshot or object description to inspect.
 * @returns Whether the value is a snapshot rejection.
 */
function isSnapshotFailure(value: JsonBoundarySnapshot | BoundaryObjectDescription): value is SnapshotFailure {
  return 'ok' in value && !value.ok;
}

/** Build one finite, detached JSON tree without re-reading live accessors. */
class JsonBoundarySnapshotter {
  private readonly ancestors = new Set<object>();
  private readonly completed = new Map<object, unknown>();

  /**
   * @param value - Raw input at the boundary, before schema parsing.
   * @returns A detached tree or structural rejection.
   */
  public snapshot(value: unknown): JsonBoundarySnapshot {
    return this.visit(value, [], 0);
  }

  private failure(kind: JsonFidelityViolationKind, path: JsonBoundaryPath): SnapshotFailure {
    return { ok: false, violation: { kind, path } };
  }

  private visit(current: unknown, path: JsonBoundaryPath, containerNesting: number): JsonBoundarySnapshot {
    if (typeof current === 'number' && Object.is(current, -0)) return this.failure('negative-zero', path);
    if (typeof current !== 'object' || current === null) return { ok: true, value: current };
    const nextNesting = containerNesting + 1;
    if (nextNesting > JSON_BOUNDARY_MAX_CONTAINER_NESTING) return this.failure('nesting-too-deep', path);
    if (this.ancestors.has(current)) return this.failure('cyclic-reference', path);
    if (this.completed.has(current)) return this.copyCompletedTree(this.completed.get(current), path, nextNesting);

    const description = this.describe(current, path);
    if (isSnapshotFailure(description)) return description;
    return this.visitObject(current, description, path, nextNesting);
  }

  private describe(current: object, path: JsonBoundaryPath): BoundaryObjectDescription | SnapshotFailure {
    try {
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key === 'symbol')) return this.failure('symbol-key', path);
      if (ownKeys.includes('__proto__')) return this.failure('prototype-key', [...path, '__proto__']);

      const isArray = Array.isArray(current);
      if (!isArray && !isPlainRecord(current)) return this.failure('non-plain-object', path);
      return this.describeProperties(current, ownKeys, isArray, path);
    } catch {
      return this.failure('unreadable-value', path);
    }
  }

  private describeProperties(
    current: object,
    ownKeys: readonly PropertyKey[],
    isArray: boolean,
    path: JsonBoundaryPath,
  ): BoundaryObjectDescription | SnapshotFailure {
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of ownKeys) {
      if (typeof key !== 'string') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined) return this.failure('unreadable-value', [...path, key]);
      if ((!isArray || key !== 'length') && !descriptor.enumerable) {
        return this.failure('non-enumerable-key', [...path, key]);
      }
      if (isArray && key !== 'length' && !isArrayIndexKey(key)) return this.failure('extra-array-key', [...path, key]);
      descriptors.set(key, descriptor);
    }
    return { isArray, descriptors };
  }

  private visitObject(
    current: object,
    description: BoundaryObjectDescription,
    path: JsonBoundaryPath,
    containerNesting: number,
  ): JsonBoundarySnapshot {
    this.ancestors.add(current);
    try {
      const result = description.isArray
        ? this.snapshotArray(current, description.descriptors, path, containerNesting)
        : this.snapshotRecord(current, description.descriptors, path, containerNesting);
      if (result.ok) this.completed.set(current, result.value);
      return result;
    } finally {
      this.ancestors.delete(current);
    }
  }

  private snapshotArray(
    current: object,
    descriptors: ReadonlyMap<string, PropertyDescriptor>,
    path: JsonBoundaryPath,
    containerNesting: number,
  ): JsonBoundarySnapshot {
    const length = descriptors.get('length')?.value;
    if (typeof length !== 'number') return this.failure('unreadable-value', [...path, 'length']);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors.get(String(index));
      if (descriptor === undefined) result.push(undefined);
      else {
        const child = this.snapshotProperty(current, descriptor, [...path, index], containerNesting);
        if (!child.ok) return child;
        result.push(child.value);
      }
    }
    return { ok: true, value: result };
  }

  private snapshotRecord(
    current: object,
    descriptors: ReadonlyMap<string, PropertyDescriptor>,
    path: JsonBoundaryPath,
    containerNesting: number,
  ): JsonBoundarySnapshot {
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of descriptors) {
      const child = this.snapshotProperty(current, descriptor, [...path, key], containerNesting);
      if (!child.ok) return child;
      defineSnapshotProperty(result, key, child.value);
    }
    return { ok: true, value: result };
  }

  private snapshotProperty(
    current: object,
    descriptor: PropertyDescriptor,
    path: JsonBoundaryPath,
    containerNesting: number,
  ): JsonBoundarySnapshot {
    const value = this.readDescriptor(current, descriptor, path);
    return isSnapshotFailure(value) ? value : this.visit(value.value, path, containerNesting);
  }

  private readDescriptor(
    current: object,
    descriptor: PropertyDescriptor,
    path: JsonBoundaryPath,
  ): JsonBoundarySnapshot {
    try {
      const value =
        'value' in descriptor ? descriptor.value : Reflect.apply(descriptor.get ?? (() => undefined), current, []);
      return { ok: true, value };
    } catch {
      return this.failure('unreadable-value', path);
    }
  }

  private copyCompletedTree(tree: unknown, path: JsonBoundaryPath, containerNesting: number): JsonBoundarySnapshot {
    // A JSON wire has no reference identity, so each repeated acyclic reference
    // deliberately becomes an independent detached subtree here. This generic
    // fidelity helper has no payload-size policy: CodeExecution applies its byte
    // limits after detachment. It is consequently not a pre-snapshot resource
    // boundary for hostile or arbitrary in-process object graphs.
    if (Array.isArray(tree)) {
      const copy: unknown[] = [];
      for (let index = 0; index < tree.length; index += 1) {
        const child = this.copyCompletedValue(tree[index], [...path, index], containerNesting);
        if (!child.ok) return child;
        copy.push(child.value);
      }
      return { ok: true, value: copy };
    }

    if (typeof tree !== 'object' || tree === null) return { ok: true, value: tree };
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tree)) {
      const child = this.copyCompletedValue(value, [...path, key], containerNesting);
      if (!child.ok) return child;
      defineSnapshotProperty(copy, key, child.value);
    }
    return { ok: true, value: copy };
  }

  private copyCompletedValue(value: unknown, path: JsonBoundaryPath, containerNesting: number): JsonBoundarySnapshot {
    if (typeof value === 'number' && Object.is(value, -0)) return this.failure('negative-zero', path);
    if (typeof value !== 'object' || value === null) return { ok: true, value };
    const nextNesting = containerNesting + 1;
    if (nextNesting > JSON_BOUNDARY_MAX_CONTAINER_NESTING) return this.failure('nesting-too-deep', path);
    return this.copyCompletedTree(value, path, nextNesting);
  }
}

/**
 * Decide whether an object is a record that JSON can represent.
 * @param value - Object to classify.
 * @returns Whether it has the ordinary or null prototype.
 */
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Define an own data property without invoking the `__proto__` setter.
 * @param target - Detached record receiving the property.
 * @param key - Property name to define.
 * @param value - Already-snapshotted value to store.
 */
function defineSnapshotProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/**
 * Create one detached, finite JSON tree for a boundary.
 *
 * An admissible enumerable accessor is read once. Objects must be plain records
 * or arrays; cycles and properties JSON cannot reproduce are rejected. Shared,
 * acyclic references are copied into the resulting JSON tree.
 * @param value - Raw input at the boundary, before schema parsing.
 * @returns A detached tree or a stable structural rejection; never throws.
 */
export function snapshotJsonBoundary(value: unknown): JsonBoundarySnapshot {
  return new JsonBoundarySnapshotter().snapshot(value);
}

/** Issue messages describing what a rewritten value would have carried. */
export interface LossyJsonValueMessages {
  /** Message for a `__proto__` own key the parse would drop. */
  readonly prototypeKey: string;
  /** Message for an object the parse would reduce to its own enumerable fields. */
  readonly nonPlainObject: string;
  /** Message for an own symbol-keyed property neither the record nor array rebuild includes. */
  readonly symbolKey: string;
  /** Message for a non-enumerable own string property the record rebuild skips. */
  readonly nonEnumerableKey: string;
  /** Message for an extra own string property on an array that the array rebuild drops. */
  readonly extraArrayKey: string;
}

/**
 * Wrap a schema so a value the parse would *rewrite* is rejected instead.
 *
 * Zod drops a `__proto__` own key while parsing a record, and rebuilds an object
 * from its own enumerable string-keyed fields, so for those two shapes the
 * parsed value differs from what the producer submitted — silently, and at any
 * depth. A post-parse `refine` cannot see either difference, because by then the
 * value has already been rebuilt; only a preprocess step observes the raw input.
 * Any boundary whose payload was authored on the far side of a trust boundary
 * and must reach this side unaltered wraps its object-admitting fields in this.
 *
 * It lives beside {@link JsonValueSchema} rather than inside it: turning the silent rewrite
 * into a rejection repo-wide would change the accepted input of every contract
 * built on that schema, so boundaries opt in explicitly.
 *
 * The wrapper is transparent in every other respect, and both halves of that
 * are contract, not coincidence:
 *
 * - It preserves the wrapped schema's declared input type. `z.preprocess` would
 *   otherwise widen it to `unknown`, even though this wrapper accepts exactly
 *   the same public input domain before applying its stricter runtime boundary.
 * - A rejected value produces exactly one issue. `z.preprocess` is a pipe, and a
 *   pipe whose first stage reported an issue never runs its second, so the inner
 *   schema never adds to a fidelity rejection. `fatal: true` would be
 *   redundant: the abort is structural, not a property of the issue.
 * @param schema - Schema to guard, applied only to the detached snapshot.
 * @param messages - Issue messages naming what the field would have carried.
 * @typeParam TSchema - Schema being guarded; its output type is preserved.
 * @returns The schema, preceded by the raw-input fidelity rejection.
 */
export function rejectingLossyJsonValues<TSchema extends z.ZodType>(
  schema: TSchema,
  messages: LossyJsonValueMessages,
): z.ZodType<z.output<TSchema>, z.input<TSchema>> {
  const messageByKind: Readonly<Record<JsonFidelityViolationKind, string>> = {
    'prototype-key': messages.prototypeKey,
    'non-plain-object': messages.nonPlainObject,
    'symbol-key': messages.symbolKey,
    'non-enumerable-key': messages.nonEnumerableKey,
    'extra-array-key': messages.extraArrayKey,
    'cyclic-reference': 'the value contains a cyclic reference and cannot be transported as JSON',
    'nesting-too-deep': `the value exceeds the maximum JSON container nesting of ${JSON_BOUNDARY_MAX_CONTAINER_NESTING}`,
    'negative-zero': 'the value contains -0, which cannot be transported as JSON without becoming 0',
    'unreadable-value': 'the value could not be read into a stable JSON boundary snapshot',
  };
  return z.preprocess((value, ctx) => {
    const snapshot = snapshotJsonBoundary(value);
    if (!snapshot.ok) {
      ctx.addIssue({
        code: 'custom',
        message: messageByKind[snapshot.violation.kind],
        path: [...snapshot.violation.path],
        input: value,
      });
      return undefined;
    }
    return snapshot.value;
  }, schema) as z.ZodType<z.output<TSchema>, z.input<TSchema>>;
}

/**
 * JSON object helper for map-like persisted configuration records.
 *
 * The runtime validation stays strict, while the public TypeScript surface
 * remains `Record<string, unknown>` so opaque config bags do not force callers
 * to thread `JsonValue` through every intermediate type.
 */
export const JsonObjectSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), JsonValueSchema);

/**
 * Contract-friendly JSON object schema for opaque config bags.
 *
 * Uses the strict runtime validator above and only narrows the public Zod
 * type. Keeping the underlying schema as `z.record()` is important for
 * protocol exports: `z.custom()` validates correctly at runtime but cannot be
 * represented as JSON Schema.
 */
export const JsonObjectContractSchema = JsonObjectSchema as z.ZodType<Record<string, unknown>, Record<string, unknown>>;

/**
 * Generic JSON-compatible parameter record.
 *
 * Use this schema when the field carries arbitrary JSON key-value pairs that
 * are NOT a JSON Schema document — for example, binding parameter maps or
 * opaque configuration payloads. The underlying validator rejects functions,
 * `undefined`, and other non-serializable values.
 *
 * Distinct from {@link JsonSchemaRecordSchema}, which carries the narrower
 * semantic of "a JSON Schema document" used for `inputSchema` / `outputSchema`
 * / `configSchema` fields.
 */
export const JsonRecordSchema: z.ZodType<Record<string, JsonValue>, Record<string, JsonValue>> = z.record(
  z.string(),
  JsonValueSchema,
) as z.ZodType<Record<string, JsonValue>, Record<string, JsonValue>>;

/**
 * Serializable JSON Schema record used for `inputSchema`, `outputSchema`, and
 * `configSchema` fields on persisted workflow definitions and node primitives.
 *
 * A JSON Schema document is itself a JSON object, so this is a
 * `Record<string, JsonValue>` — identical at runtime to {@link JsonObjectContractSchema}
 * but carries a semantically narrower name to distinguish "a JSON Schema document"
 * from "an arbitrary JSON payload".
 *
 * The underlying `z.record(z.string(), JsonValueSchema)` validator rejects
 * functions, `undefined`, and other non-serializable values, keeping persisted
 * workflow definitions purely JSON-safe.
 *
 * For non-schema JSON records (e.g. parameter maps), use {@link JsonRecordSchema}.
 */
export const JsonSchemaRecordSchema: z.ZodType<Record<string, JsonValue>, Record<string, JsonValue>> = JsonRecordSchema;

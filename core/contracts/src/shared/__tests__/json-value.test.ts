import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JSON_BOUNDARY_MAX_CONTAINER_NESTING,
  JsonValueSchema,
  rejectingLossyJsonValues,
  snapshotJsonBoundary,
} from '../json-value.js';

const snapshotViolation = (value: unknown) => {
  const snapshot = snapshotJsonBoundary(value);
  return snapshot.ok ? undefined : snapshot.violation;
};

/**
 * Attach a `__proto__` own key to a container the way only code can.
 *
 * `JSON.parse` produces the key on objects, but never on arrays — an array's
 * JSON text has no place to spell a named key. `Object.defineProperty` is the
 * only way an array acquires one, which is precisely why the probe has to look
 * for it there rather than assume arrays cannot carry it.
 * @param container - Object or array to give a `__proto__` own key.
 * @returns The same container, now carrying the key.
 */
function withPrototypeOwnKey<TContainer extends object>(container: TContainer): TContainer {
  Object.defineProperty(container, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return container;
}

/**
 * Attach an own symbol-keyed property to a container.
 *
 * Symbol keys are dropped by both `z.record()` and `z.array()` because JSON has
 * no symbol representation. This helper creates a reproducible fixture for that
 * case without requiring a cast in the call site.
 * @param container - Object or array to annotate.
 * @returns The same container, now carrying a symbol-keyed own property.
 */
function withSymbolOwnKey<TContainer extends object>(container: TContainer): TContainer {
  Object.defineProperty(container, Symbol('sym'), {
    value: 'sym-value',
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return container;
}

/**
 * Attach a non-enumerable own string property to a plain object.
 *
 * `Object.entries` skips non-enumerable properties, so `z.record()` does not
 * copy the key onto the rebuilt object.
 * @param base - Enumerable own properties for the object.
 * @param hiddenKey - The non-enumerable key to attach.
 * @returns The same object with the hidden property installed.
 */
function withNonEnumerableKey<TBase extends object>(base: TBase, hiddenKey: string): TBase {
  Object.defineProperty(base, hiddenKey, { value: 42, enumerable: false, configurable: true, writable: true });
  return base;
}

/**
 * Attach a named extra own property to an array.
 *
 * `z.array()` rebuilds from indexed elements only, so a non-index string
 * property is silently dropped from the parsed output.
 * @param arr - The array to annotate.
 * @param key - The non-index property name to attach.
 * @returns The same array, now carrying the extra property.
 */
function withExtraArrayKey<TElement>(arr: TElement[], key: string): TElement[] {
  Object.defineProperty(arr, key, { value: 'extra', enumerable: true, configurable: true, writable: true });
  return arr;
}

/**
 * Create a JSON tree with exactly the requested number of containers.
 * @param kind - Container shape to repeat.
 * @param count - Number of nested containers to create.
 * @returns A leaf wrapped in exactly `count` containers.
 */
function nestedContainers(kind: 'array' | 'record', count: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < count; index += 1) value = kind === 'array' ? [value] : { value };
  return value;
}

describe('JsonValueSchema', () => {
  it('accepts nested JSON-safe values', () => {
    expect(
      JsonValueSchema.safeParse({
        enabled: true,
        retries: 3,
        labels: ['alpha', 'beta'],
        nested: {
          value: null,
          config: {
            endpoint: 'https://example.test',
          },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects non-JSON runtime values', () => {
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(new Map()).success).toBe(false);
    expect(JsonValueSchema.safeParse(() => 'nope').success).toBe(false);
    expect(JsonValueSchema.safeParse({ nested: { invalid: undefined } }).success).toBe(false);
  });
});

/**
 * A class instance that passes Zod's own "looks like a plain object" heuristic.
 *
 * The heuristic accepts any object whose prototype carries an own
 * `isPrototypeOf`, so an instance can opt into it — and a prototype `toJSON`
 * then makes the record rebuild disagree with the value's own JSON form. This is
 * the case that proves the probe decides fidelity on the prototype rather than
 * inheriting whatever a dependency currently happens to reject.
 */
class PlainImpersonator {
  /** Own enumerable field a record parse would rebuild the value from. */
  public readonly kept = 1;

  /**
   * Serialize to something the rebuilt object could never equal.
   * @returns The value's JSON form.
   */
  public toJSON(): string {
    return 'serialized';
  }
}

Object.defineProperty(PlainImpersonator.prototype, 'isPrototypeOf', {
  value: Object.prototype.isPrototypeOf,
  configurable: true,
  writable: true,
});

describe('snapshotJsonBoundary structural rejections', () => {
  it('answers undefined for values the schema reproduces exactly', () => {
    expect(snapshotViolation(JSON.parse('{"a":{"b":[1,"two",null,{"c":[]}]},"d":false}'))).toBeUndefined();
    expect(snapshotViolation([1, 'two', null, { nested: [] }])).toBeUndefined();
    expect(snapshotViolation('__proto__')).toBeUndefined();
    expect(snapshotViolation(null)).toBeUndefined();
    expect(snapshotViolation(undefined)).toBeUndefined();
    // A record rebuilds a null-prototype object faithfully, so it stays admissible.
    expect(snapshotViolation(Object.assign(Object.create(null), { a: 1 }))).toBeUndefined();
  });

  it.each<[string, unknown, readonly (string | number)[]]>([
    ['an object at the top level', withPrototypeOwnKey({ kept: 1 }), ['__proto__']],
    ['an object nested in an object', { outer: withPrototypeOwnKey({}) }, ['outer', '__proto__']],
    ['an object nested in an array', [withPrototypeOwnKey({})], [0, '__proto__']],
    ['an array at the top level', withPrototypeOwnKey(['kept']), ['__proto__']],
    ['an array nested in an object', { items: withPrototypeOwnKey(['kept']) }, ['items', '__proto__']],
    ['an array nested in an array', [[withPrototypeOwnKey([])]], [0, 0, '__proto__']],
  ])('reports the path of a __proto__ own key on %s', (_case, value, path) => {
    expect(snapshotViolation(value)).toEqual({ kind: 'prototype-key', path });
  });

  it.each<[string, unknown, readonly (string | number)[]]>([
    ['a Date at the top level', new Date(0), []],
    ['a Map at the top level', new Map([['a', 1]]), []],
    ['a class instance nested in an object', { at: new Date(0) }, ['at']],
    ['a class instance nested in an array', [[new Map()]], [0, 0]],
  ])('reports the path of a non-plain object at %s', (_case, value, path) => {
    expect(snapshotViolation(value)).toEqual({ kind: 'non-plain-object', path });
  });

  it('finds the key on a value the schema itself accepts after silently dropping it', () => {
    // This is the whole reason the probe exists: `z.array()` rebuilds the array
    // from its elements, so the own key never reaches the parsed output and no
    // post-parse rule could observe that the value changed.
    const items = withPrototypeOwnKey(['kept']);

    const parsed = JsonValueSchema.safeParse(items);

    expect(parsed.success).toBe(true);
    const data = parsed.data;
    expect(Array.isArray(data) && Object.hasOwn(data, '__proto__')).toBe(false);
    expect(snapshotViolation(items)).toEqual({ kind: 'prototype-key', path: ['__proto__'] });
  });

  it('finds a non-plain object whose own fields do not reproduce it', () => {
    // The second reason the probe exists, stated without reference to any
    // schema: rebuilding this value from its own enumerable string-keyed fields
    // — which is what a record parse does — produces something whose JSON form
    // contradicts the value's own. That is the contract rule, and it holds
    // whatever a validation dependency happens to accept.
    const impersonator = new PlainImpersonator();

    expect(JSON.stringify({ ...impersonator })).not.toBe(JSON.stringify(impersonator));
    expect(snapshotViolation(impersonator)).toEqual({ kind: 'non-plain-object', path: [] });
  });

  it.each<[string, unknown]>([
    ['a plain object at the top level', withSymbolOwnKey({ a: 1 })],
    ['a plain object nested in an object', { outer: withSymbolOwnKey({}) }],
    ['a plain object nested in an array', [withSymbolOwnKey({})]],
    ['an array at the top level', withSymbolOwnKey([1])],
  ])('reports symbol-keyed own property on %s', (_case, value) => {
    const result = snapshotViolation(value);
    expect(result?.kind).toBe('symbol-key');
  });

  it('reports a symbol-keyed violation with a path ending at the containing object, not the symbol itself', () => {
    // Path ends at 'nested' (the object carrying the symbol); symbols cannot
    // appear in a JSON path, so the path does not extend further.
    expect(snapshotViolation({ nested: withSymbolOwnKey({}) })).toEqual({
      kind: 'symbol-key',
      path: ['nested'],
    });
  });

  it.each<[string, unknown, readonly string[]]>([
    ['a plain object at the top level', withNonEnumerableKey({ a: 1 }, 'hidden'), ['hidden']],
    ['a plain object nested in an object', { outer: withNonEnumerableKey({ a: 1 }, 'hidden') }, ['outer', 'hidden']],
    ['a plain object with the name reserved for array length', withNonEnumerableKey({}, 'length'), ['length']],
  ])('reports a non-enumerable own string property on %s', (_case, value, path) => {
    expect(snapshotViolation(value)).toEqual({ kind: 'non-enumerable-key', path });
  });

  it('reports an extra own string property on an array at the top level', () => {
    expect(snapshotViolation(withExtraArrayKey([1, 2, 3], 'x'))).toEqual({
      kind: 'extra-array-key',
      path: ['x'],
    });
  });

  it('reports an extra own string property on an array nested in an object', () => {
    expect(snapshotViolation({ items: withExtraArrayKey(['a'], 'x') })).toEqual({
      kind: 'extra-array-key',
      path: ['items', 'x'],
    });
  });

  it('finds the extra array own property that z.array() silently drops on rebuild', () => {
    // Empirical proof of the schema-rebuild premise: z.array() rebuilds from
    // indexed elements only, so an extra own string property is not present on
    // the parsed output even though the parse succeeds.
    const arr = withExtraArrayKey([1, 2], 'extra');

    const parsed = JsonValueSchema.safeParse(arr);

    expect(parsed.success).toBe(true);
    expect(Object.hasOwn(parsed.data as object, 'extra')).toBe(false);
    expect(snapshotViolation(arr)).toEqual({ kind: 'extra-array-key', path: ['extra'] });
  });

  it.each<[string, string]>([
    ['a non-canonical spelling of an index', '01'],
    ['the maximum array length, which is one past the last index', '4294967295'],
    ['a fractional numeric key', '0.5'],
    ['an exponent-form numeric key', '1e2'],
    ['a negative numeric key', '-1'],
  ])('reports a numeric-looking own array property that is not an index: %s', (_case, key) => {
    // None of these is an array index, so z.array() drops each one exactly as it
    // drops a named property. Each defeats a different shortcut: '01' and
    // '4294967295' pass a digits-only test, while '0.5' and '-1' survive a bare
    // Number round-trip and are caught only by the integer and range tests.
    const arr = withExtraArrayKey([1, 2], key);

    const parsed = JsonValueSchema.safeParse(arr);

    expect(parsed.success).toBe(true);
    expect(Object.hasOwn(parsed.data as object, key)).toBe(false);
    expect(snapshotViolation(arr)).toEqual({ kind: 'extra-array-key', path: [key] });
  });

  it('leaves a canonical array index installed the same way alone', () => {
    // The discriminating half of the rule above: the rejection must turn on the
    // key not being an index, not on how the property was installed. Defining
    // '2' on a two-element array makes it a real element slot — length grows to
    // three — and the rebuild keeps it.
    const arr = withExtraArrayKey([1, 2], '2');

    const parsed = JsonValueSchema.safeParse(arr);

    expect(arr).toHaveLength(3);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([1, 2, 'extra']);
    expect(snapshotViolation(arr)).toBeUndefined();
  });

  it('does not report a violation for plain objects or arrays without hidden own properties', () => {
    expect(snapshotViolation({ a: 1, b: [2, { c: 3 }] })).toBeUndefined();
    expect(snapshotViolation([1, 'two', null, { nested: [] }])).toBeUndefined();
    expect(snapshotViolation(Object.assign(Object.create(null), { a: 1 }))).toBeUndefined();
  });
});

describe('snapshotJsonBoundary', () => {
  it.each(['array', 'record'] as const)('accepts %s trees at the documented container-nesting limit', (kind) => {
    const snapshot = snapshotJsonBoundary(nestedContainers(kind, JSON_BOUNDARY_MAX_CONTAINER_NESTING));

    expect(snapshot.ok).toBe(true);
  });

  it.each(['array', 'record'] as const)('rejects the 129th container in a %s tree without throwing', (kind) => {
    const value = nestedContainers(kind, JSON_BOUNDARY_MAX_CONTAINER_NESTING + 1);

    expect(snapshotViolation(value)).toMatchObject({ kind: 'nesting-too-deep' });
    const schema = rejectingLossyJsonValues(JsonValueSchema, {
      prototypeKey: 'prototype',
      nonPlainObject: 'non-plain',
      symbolKey: 'symbol',
      nonEnumerableKey: 'non-enumerable',
      extraArrayKey: 'array key',
    });
    expect(() => schema.safeParse(value)).not.toThrow();
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each<[string, unknown, readonly (string | number)[]]>([
    ['at the root', -0, []],
    ['nested in an object', { value: -0 }, ['value']],
    ['nested in an array', [-0], [0]],
  ])('rejects negative zero %s because JSON would transport it as zero', (_case, value, path) => {
    expect(snapshotViolation(value)).toEqual({ kind: 'negative-zero', path });
  });

  it('copies an acyclic shared reference into a detached JSON tree', () => {
    const shared = { value: 1 };
    const source = { first: shared, second: shared };

    const snapshot = snapshotJsonBoundary(source);

    expect(snapshot).toEqual({ ok: true, value: { first: { value: 1 }, second: { value: 1 } } });
    if (!snapshot.ok) throw new Error('expected an admissible snapshot');
    expect(snapshot.value).not.toBe(source);
    expect((snapshot.value as { first: object }).first).not.toBe(shared);
  });

  it('reads a getter on a shared reference once while copying its snapshot for each use', () => {
    let reads = 0;
    const shared: Record<string, unknown> = {};
    Object.defineProperty(shared, 'value', {
      enumerable: true,
      get: (): number => {
        reads += 1;
        return 1;
      },
    });

    expect(snapshotJsonBoundary({ first: shared, second: shared })).toEqual({
      ok: true,
      value: { first: { value: 1 }, second: { value: 1 } },
    });
    expect(reads).toBe(1);
  });

  it('rejects a cycle without recursing through the schema', () => {
    const source: { self?: unknown } = {};
    source.self = source;

    expect(snapshotJsonBoundary(source)).toEqual({
      ok: false,
      violation: { kind: 'cyclic-reference', path: ['self'] },
    });
  });

  it('reads an admissible enumerable getter once and gives the schema its snapshot', () => {
    let reads = 0;
    const source: Record<string, unknown> = {};
    Object.defineProperty(source, 'value', {
      enumerable: true,
      get: (): number => {
        reads += 1;
        return reads;
      },
    });
    const schema = rejectingLossyJsonValues(z.object({ value: z.number() }), {
      prototypeKey: 'prototype',
      nonPlainObject: 'non-plain',
      symbolKey: 'symbol',
      nonEnumerableKey: 'non-enumerable',
      extraArrayKey: 'array key',
    });

    expect(schema.parse(source)).toEqual({ value: 1 });
    expect(reads).toBe(1);
  });

  it('turns an accessor failure into a stable rejection', () => {
    const source: Record<string, unknown> = {};
    Object.defineProperty(source, 'value', {
      enumerable: true,
      get: (): never => {
        throw new Error('unreadable');
      },
    });

    expect(snapshotJsonBoundary(source)).toEqual({
      ok: false,
      violation: { kind: 'unreadable-value', path: ['value'] },
    });
  });
});

// Isolated deliberately. The assertion below is the only one in this file that
// depends on Zod's internal "looks like a plain object" heuristic, which is not
// a stated contract of the library and can change with an upgrade. Keeping it in
// its own named case means such an upgrade fails *here*, identifying the
// dependency, rather than inside a case about the probe's own behaviour — and
// the probe's rule stays asserted independently either way.
describe('the Zod plain-object heuristic the snapshot deliberately does not rely on', () => {
  it('currently accepts a class instance that opts into it, and rebuilds it into something else', () => {
    const impersonator = new PlainImpersonator();

    const parsed = JsonValueSchema.safeParse(impersonator);

    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed.data)).not.toBe(JSON.stringify(impersonator));
  });
});

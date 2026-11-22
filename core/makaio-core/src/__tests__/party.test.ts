import { describe, expect, it } from 'vitest';
import {
  CallClaimSchema,
  CorePartyKind,
  isCallClaim,
  isInProcessCaller,
  MAKAIO_CLI_LOCAL_PARTY_KIND,
  MAKAIO_E2E_PEER_PARTY_KIND,
  MAKAIO_EXTENSION_PARTY_KIND,
  MAKAIO_HOST_PARTY_KIND,
  MAKAIO_LOOPBACK_PARTY_KIND,
  MAKAIO_WORKER_THREAD_PARTY_KIND,
  MAKAIO_JOB_RUN_PARTY_KIND,
  MAKAIO_RULES_PARTY_KIND,
  MAKAIO_ANONYMOUS_PARTY_KIND,
  MAKAIO_WITNESSED_ACCOUNT_PARTY_KIND,
  MAKAIO_WORKER_PROVIDER_PARTY_KIND,
  MAKAIO_STEP_EXECUTION_PARTY_KIND,
  PartyRefSchema,
  PartySchema,
} from '../types/party.js';
import type { MakaioPartyKind, PartyKind } from '../types/party.js';

describe('party kind constants', () => {
  it('holds the seven core kinds, all valid contribution names under makaio.', () => {
    const kinds = {
      extension: MAKAIO_EXTENSION_PARTY_KIND,
      host: MAKAIO_HOST_PARTY_KIND,
      loopback: MAKAIO_LOOPBACK_PARTY_KIND,
      cliLocal: MAKAIO_CLI_LOCAL_PARTY_KIND,
      e2ePeer: MAKAIO_E2E_PEER_PARTY_KIND,
      workerThread: MAKAIO_WORKER_THREAD_PARTY_KIND,
      jobRun: MAKAIO_JOB_RUN_PARTY_KIND,
    };
    expect(kinds).toEqual({
      extension: 'makaio.extension',
      host: 'makaio.host',
      loopback: 'makaio.loopback',
      cliLocal: 'makaio.cli-local',
      e2ePeer: 'makaio.e2e-peer',
      workerThread: 'makaio.worker-thread',
      jobRun: 'makaio.job-run',
    });
    for (const kind of Object.values(kinds)) {
      expect(PartyRefSchema.safeParse({ kind, id: 'x' }).success).toBe(true);
    }
  });
});

describe('CorePartyKind', () => {
  it('holds the five additional literal kinds', () => {
    expect(MAKAIO_RULES_PARTY_KIND).toBe('makaio.rules');
    expect(MAKAIO_ANONYMOUS_PARTY_KIND).toBe('makaio.anonymous');
    expect(MAKAIO_WITNESSED_ACCOUNT_PARTY_KIND).toBe('makaio.witnessed-account');
    expect(MAKAIO_WORKER_PROVIDER_PARTY_KIND).toBe('makaio.worker-provider');
    expect(MAKAIO_STEP_EXECUTION_PARTY_KIND).toBe('makaio.step-execution');
  });

  it('holds twelve distinct kinds, each a valid party kind', () => {
    const kinds = Object.values(CorePartyKind);
    expect(kinds).toHaveLength(12);
    expect(new Set(kinds).size).toBe(12);
    for (const kind of kinds) {
      expect(PartyRefSchema.shape.kind.safeParse(kind).success).toBe(true);
    }
  });

  it('keeps PartyKind open while MakaioPartyKind is only the core kinds', () => {
    const core: MakaioPartyKind = CorePartyKind.rules;
    const asPartyKind: PartyKind = core;
    const other: PartyKind = 'acme.custom';
    // @ts-expect-error an arbitrary contribution name is not a core kind
    const notCore: MakaioPartyKind = other;
    expect([asPartyKind, notCore]).toEqual(['makaio.rules', 'acme.custom']);
  });
});

describe('isInProcessCaller', () => {
  it('is true only for extension and host', () => {
    expect(isInProcessCaller({ caller: { kind: MAKAIO_EXTENSION_PARTY_KIND, id: 'a' } })).toBe(true);
    expect(isInProcessCaller({ caller: { kind: MAKAIO_HOST_PARTY_KIND, id: 'a' } })).toBe(true);
  });

  it('is false for the five remaining core kinds', () => {
    for (const kind of [
      MAKAIO_LOOPBACK_PARTY_KIND,
      MAKAIO_CLI_LOCAL_PARTY_KIND,
      MAKAIO_E2E_PEER_PARTY_KIND,
      MAKAIO_WORKER_THREAD_PARTY_KIND,
      MAKAIO_JOB_RUN_PARTY_KIND,
    ]) {
      expect(isInProcessCaller({ caller: { kind, id: 'a' } })).toBe(false);
    }
  });

  it('is false for an unknown kind', () => {
    expect(isInProcessCaller({ caller: { kind: 'acme.thing', id: 'a' } })).toBe(false);
  });
});

describe('PartyRefSchema and PartySchema', () => {
  it('accepts a party ref and rejects claims and unknown keys on it', () => {
    expect(PartyRefSchema.safeParse({ kind: 'acme.user', id: '1' }).success).toBe(true);
    expect(PartyRefSchema.safeParse({ kind: 'acme.user', id: '1', claims: {} }).success).toBe(false);
    expect(PartyRefSchema.safeParse({ kind: 'acme.user', id: '1', extra: 1 }).success).toBe(false);
  });

  it('rejects invalid kinds and empty ids', () => {
    expect(PartyRefSchema.safeParse({ kind: 'nodot', id: '1' }).success).toBe(false);
    expect(PartyRefSchema.safeParse({ kind: '.leading', id: '1' }).success).toBe(false);
    expect(PartyRefSchema.safeParse({ kind: 'trailing.', id: '1' }).success).toBe(false);
    expect(PartyRefSchema.safeParse({ kind: 'acme.user', id: '' }).success).toBe(false);
  });

  it('accepts a party with and without claims', () => {
    expect(PartySchema.safeParse({ kind: 'acme.user', id: '1' }).success).toBe(true);
    expect(
      PartySchema.safeParse({ kind: 'acme.user', id: '1', claims: { exec: 'e-1', n: [1, { a: null }] } }).success,
    ).toBe(true);
  });

  it('rejects non-JSON claims, cyclic claims and unknown keys', () => {
    expect(PartySchema.safeParse({ kind: 'acme.user', id: '1', claims: { f: () => 1 } }).success).toBe(false);
    expect(PartySchema.safeParse({ kind: 'acme.user', id: '1', claims: { d: new Date() } }).success).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(PartySchema.safeParse({ kind: 'acme.user', id: '1', claims: cyclic }).success).toBe(false);
    expect(PartySchema.safeParse({ kind: 'acme.user', id: '1', extra: true }).success).toBe(false);
  });

  it('CallClaimSchema agrees with isCallClaim', () => {
    expect(CallClaimSchema.safeParse({ a: [1] }).success).toBe(true);
    expect(CallClaimSchema.safeParse(undefined).success).toBe(false);
  });

  it('CallClaimSchema rejects cycles, proxies over non-plain targets, dates and NaN without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const rejected: unknown[] = [cyclic, new Proxy(new Date(), {}), new Date(), Number.NaN];
    for (const value of rejected) {
      expect(() => CallClaimSchema.safeParse(value)).not.toThrow();
      expect(CallClaimSchema.safeParse(value).success).toBe(false);
    }
  });

  it('CallClaimSchema and PartySchema accept a deeply shared reference graph', () => {
    let value: unknown = {};
    for (let depth = 0; depth < 40; depth++) {
      value = { a: value, b: value };
    }
    expect(CallClaimSchema.safeParse(value).success).toBe(true);
    expect(PartySchema.safeParse({ kind: 'acme.user', id: '1', claims: { x: value } }).success).toBe(true);
  });

  it('CallClaimSchema and PartySchema accept 100000-deep nesting without throwing', () => {
    let array: unknown[] = [];
    let object: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i += 1) {
      array = [array];
      object = { a: object };
    }
    for (const value of [array, object]) {
      expect(() => CallClaimSchema.safeParse(value)).not.toThrow();
      expect(CallClaimSchema.safeParse(value).success).toBe(true);
      expect(PartySchema.safeParse({ kind: 'acme.user', id: '1', claims: { x: value } }).success).toBe(true);
    }
  });
});

describe('isCallClaim rejects non-plain shapes', () => {
  it('rejects a symbol key', () => {
    expect(isCallClaim({ a: 1, [Symbol('s')]: 2 })).toBe(false);
  });

  it('rejects a non-enumerable getter', () => {
    const value = {};
    Object.defineProperty(value, 'a', { get: () => 1, enumerable: false });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects a non-enumerable property holding a function', () => {
    const value = {};
    Object.defineProperty(value, 'a', { value: () => 1, enumerable: false });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects a non-enumerable property holding plain data', () => {
    const value = {};
    Object.defineProperty(value, 'a', { value: 1, enumerable: false });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an enumerable getter', () => {
    expect(
      isCallClaim({
        get a() {
          return 1;
        },
      }),
    ).toBe(false);
  });

  it('rejects an accessor with only a setter', () => {
    const value = {};
    Object.defineProperty(value, 'a', { set: () => undefined, enumerable: true });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an array with an accessor on an index', () => {
    const value = [1, 2];
    Object.defineProperty(value, 1, { get: () => 2, enumerable: true });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an array with an extra own property', () => {
    const value: unknown[] = [1];
    Object.defineProperty(value, 'extra', { value: 1, enumerable: true });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an array with a different prototype', () => {
    const value = [1];
    Object.setPrototypeOf(value, {});
    expect(isCallClaim(value)).toBe(false);
    class Sub extends Array {}
    expect(isCallClaim(Sub.from([1]))).toBe(false);
  });

  it('rejects an array with a hole', () => {
    const holey: unknown[] = new Array(3);
    holey[0] = 1;
    holey[2] = 3;
    expect(1 in holey).toBe(false);
    expect(isCallClaim(holey)).toBe(false);
  });

  it('rejects an array with non-enumerable elements', () => {
    const value = [1, 2];
    Object.defineProperty(value, 0, { value: 1, enumerable: false });
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an own key __proto__ built through JSON.parse', () => {
    const value: unknown = JSON.parse('{"__proto__": {"a": 1}}');
    expect(Object.keys(value as object)).toContain('__proto__');
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects a class instance and a Date', () => {
    class Box {
      readonly a = 1;
    }
    expect(isCallClaim(new Box())).toBe(false);
    expect(isCallClaim(new Date())).toBe(false);
    expect(isCallClaim({ nested: new Date() })).toBe(false);
  });
});

describe('isCallClaim rejects non-JSON leaves', () => {
  it.each([
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s at the top and nested', (_name, leaf) => {
    expect(isCallClaim(leaf)).toBe(false);
    expect(isCallClaim({ a: leaf })).toBe(false);
    expect(isCallClaim([leaf])).toBe(false);
  });
});

describe('isCallClaim is independent of the prototype chain', () => {
  it('still validates when Object.prototype carries a `leave` property', () => {
    Object.defineProperty(Object.prototype, 'leave', { value: {}, configurable: true });
    try {
      expect(isCallClaim(undefined)).toBe(false);
      expect(isCallClaim(() => 1)).toBe(false);
      expect(CallClaimSchema.safeParse(undefined).success).toBe(false);
      expect(isCallClaim({ a: [1, 'x', null] })).toBe(true);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'leave');
    }
  });

  it('still rejects an accessor when Object.prototype carries a `value` property', () => {
    // Built before the pollution: a polluted `value` would leak into the descriptor passed to defineProperty.
    const withGetter = Object.defineProperty({}, 'a', { get: () => 1, enumerable: true });
    Object.defineProperty(Object.prototype, 'value', { value: 'polluted', configurable: true });
    let getterAccepted: boolean;
    let plainAccepted: boolean;
    try {
      // Only the guard runs while polluted: lazily loaded runtime internals break on a polluted `value`.
      getterAccepted = isCallClaim(withGetter);
      plainAccepted = isCallClaim({ a: [1, 'x', null] });
    } finally {
      Reflect.deleteProperty(Object.prototype, 'value');
    }
    expect(getterAccepted).toBe(false);
    expect(plainAccepted).toBe(true);
  });
});

describe('isCallClaim rejects cycles', () => {
  it('rejects an object cycle', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an array cycle', () => {
    const value: unknown[] = [];
    value.push(value);
    expect(isCallClaim(value)).toBe(false);
  });

  it('rejects an indirect cycle A -> B -> A', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    expect(isCallClaim(a)).toBe(false);
  });
});

describe('isCallClaim accepts plain data', () => {
  it('accepts a nested claim with every leaf type', () => {
    expect(
      isCallClaim({ s: 'x', n: 1.5, z: 0, neg: -1, t: true, f: false, nil: null, arr: ['a', 1, true, null, [{}]] }),
    ).toBe(true);
  });

  it('accepts primitives at the top', () => {
    for (const value of ['x', 0, true, false, null]) {
      expect(isCallClaim(value)).toBe(true);
    }
  });

  it('accepts an object with a null prototype', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.a = 1;
    expect(isCallClaim(value)).toBe(true);
  });

  it('accepts a shared, non-cyclic reference', () => {
    const shared = { k: [1, 2] };
    expect(isCallClaim({ a: shared, b: shared, c: [shared, shared] })).toBe(true);
  });

  it('accepts a deeply shared reference chain in linear time', () => {
    let value: unknown = {};
    for (let depth = 0; depth < 40; depth++) {
      value = { a: value, b: value };
    }
    expect(isCallClaim(value)).toBe(true);
  });

  it.each([
    ['cycle branch before the validated branch', ['cycle', 'done']],
    ['validated branch before the cycle branch', ['done', 'cycle']],
  ] as const)('still rejects a cycle closed after a shared node was validated (%s)', (_label, order) => {
    const shared = { k: 1 };
    const root: Record<string, unknown> = {};
    // Keys are visited last-first. Inside `cycle`, `s1` and `s2` come before `back`, so the shared node is
    // validated through `s1`, skipped through `s2` (validated set), and `back` is rejected through the ancestors set.
    const cycle = { back: root, s2: shared, s1: shared };
    for (const key of order) {
      root[key] = key === 'cycle' ? cycle : shared;
    }
    expect(isCallClaim(root)).toBe(false);
  });

  it('accepts an empty object and an empty array', () => {
    expect(isCallClaim({})).toBe(true);
    expect(isCallClaim([])).toBe(true);
  });

  it('accepts an array nested 100000 deep without a stack overflow', () => {
    let value: unknown[] = [];
    for (let i = 0; i < 100_000; i += 1) {
      value = [value];
    }
    expect(isCallClaim(value)).toBe(true);
  });

  it('accepts an object chain nested 100000 deep without a stack overflow', () => {
    let value: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i += 1) {
      value = { a: value };
    }
    expect(isCallClaim(value)).toBe(true);
  });
});

describe('isCallClaim rejects a huge sparse array at once', () => {
  it('rejects new Array(1e9) without walking its length', () => {
    const started = performance.now();
    expect(isCallClaim(new Array(1e9))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

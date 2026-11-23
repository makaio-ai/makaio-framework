import type { CallContext } from '@makaio/core';
import { describe, expect, it } from 'vitest';
import type { CallContextInput, MintCallContextOptions } from '../call-context/mint.js';
import {
  InvalidCallContextError,
  isMintedCallContext,
  mintCallContext,
  ownCarrierOf,
  ownPurposeOf,
} from '../call-context/mint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mint from a value the type system would refuse, to exercise the runtime checks.
 * @param input - Any value standing in for the input.
 * @param options - Any value standing in for the options.
 * @returns The minted context.
 */
function mintLoose(input: unknown, options?: unknown): CallContext {
  return mintCallContext(input as CallContextInput, options as MintCallContextOptions | undefined);
}

/**
 * Capture the error thrown by `run`.
 * @param run - Function expected to throw.
 * @returns The thrown value.
 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/**
 * Assert that `run` throws an `InvalidCallContextError` whose message names `path` and never `secret`.
 * @param run - Function expected to throw.
 * @param path - Fragment of the place the message must name.
 * @param secret - Value that must not appear in the message.
 */
function expectRejected(run: () => unknown, path: string, secret = 'never-in-message'): void {
  const error = thrownBy(run);
  expect(error).toBeInstanceOf(InvalidCallContextError);
  const message = error instanceof Error ? error.message : '';
  expect(message).toContain(path);
  expect(message).not.toContain(secret);
}

/**
 * Whether `value` and every object reachable from it is frozen.
 * @param value - Root of the tree.
 * @returns `true` when the whole tree is frozen.
 */
function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => isDeeplyFrozen(Reflect.get(value, key)));
}

const caller: { kind: string; id: string } = { kind: 'acme.user', id: 'u-1' };
const principal: { kind: string; id: string } = { kind: 'acme.service', id: 's-1' };

// ---------------------------------------------------------------------------
// Copy and registration
// ---------------------------------------------------------------------------

describe('mintCallContext: result', () => {
  it('returns the three parties as a registered context', () => {
    const attestedBy = { kind: 'acme.idp', id: 'idp-1' };
    const call = mintCallContext({ caller, principal, attestedBy });

    expect(call.caller).toEqual(caller);
    expect(call.principal).toEqual(principal);
    expect(call.attestedBy).toEqual(attestedBy);
    expect(isMintedCallContext(call)).toBe(true);
  });

  it('leaves attestedBy absent when the input has none', () => {
    const call = mintCallContext({ caller, principal });

    expect('attestedBy' in call).toBe(false);
  });

  it('does not register a spread, a literal or a copy of a minted context', () => {
    const call = mintCallContext({ caller, principal });

    expect(isMintedCallContext({ ...call })).toBe(false);
    expect(isMintedCallContext({ caller, principal })).toBe(false);
    expect(isMintedCallContext(structuredClone(call))).toBe(false);
    expect(isMintedCallContext(Object.create(call))).toBe(false);
    expect(isMintedCallContext(null)).toBe(false);
    expect(isMintedCallContext('call')).toBe(false);
  });

  it('returns a new context for every mint, even for equal input', () => {
    const first = mintCallContext({ caller, principal });
    const second = mintCallContext({ caller, principal });

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('shares no object with the input', () => {
    const input = { caller: { ...caller, claims: { roles: ['a'] } }, principal: { ...principal } };
    const call = mintCallContext(input);

    expect(call).not.toBe(input);
    expect(call.caller).not.toBe(input.caller);
    expect(call.principal).not.toBe(input.principal);
    expect(call.caller.claims).not.toBe(input.caller.claims);
    expect(call.caller.claims?.roles).not.toBe(input.caller.claims.roles);
  });

  it('never changes the input', () => {
    const input = { caller: { ...caller, claims: { roles: ['a'] } }, principal: { ...principal } };
    const before = structuredClone(input);

    mintCallContext(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.caller)).toBe(false);
    expect(Object.isFrozen(input.caller.claims)).toBe(false);
    expect(Object.isFrozen(input.caller.claims.roles)).toBe(false);
  });

  it('accepts an input that is frozen already', () => {
    const input = Object.freeze({ caller: Object.freeze({ ...caller }), principal: Object.freeze({ ...principal }) });

    expect(isMintedCallContext(mintCallContext(input))).toBe(true);
  });

  it('accepts parties and input with a null prototype', () => {
    const party = Object.assign(Object.create(null), caller);
    const input = Object.assign(Object.create(null), { caller: party, principal });

    expect(mintCallContext(input).caller).toEqual(caller);
  });
});

// ---------------------------------------------------------------------------
// Detaching from the input (aliases)
// ---------------------------------------------------------------------------

describe('mintCallContext: input aliases', () => {
  it('is not changed by later writes to the input parties', () => {
    const callerInput = { ...caller };
    const principalInput = { ...principal };
    const call = mintCallContext({ caller: callerInput, principal: principalInput });

    callerInput.id = 'changed';
    principalInput.kind = 'acme.other';

    expect(call.caller.id).toBe('u-1');
    expect(call.principal.kind).toBe('acme.service');
  });

  it('is not changed by later writes to nested claims', () => {
    const roles = ['admin'];
    const nested = { deep: { flag: true } };
    const claims = { roles, nested };
    const call = mintCallContext({ caller: { ...caller, claims }, principal });

    roles.push('root');
    nested.deep.flag = false;
    claims.nested = { deep: { flag: false } };

    expect(call.caller.claims).toEqual({ roles: ['admin'], nested: { deep: { flag: true } } });
  });

  it('keeps the same claims object of two parties apart', () => {
    const claims = { roles: ['a'] };
    const call = mintCallContext({ caller: { ...caller, claims }, principal: { ...principal, claims } });

    expect(call.caller.claims).toEqual(call.principal.claims);
    expect(call.caller.claims).not.toBe(call.principal.claims);
    expect(call.caller.claims).not.toBe(claims);
  });

  it('keeps one object shared inside the input as separate copies or one frozen copy, never the original', () => {
    const shared = { n: 1 };
    const call = mintCallContext({ caller: { ...caller, claims: { a: shared, b: shared } }, principal });

    expect(call.caller.claims?.a).not.toBe(shared);
    expect(call.caller.claims?.b).not.toBe(shared);
    expect(Object.isFrozen(call.caller.claims?.a)).toBe(true);
    expect(shared).toEqual({ n: 1 });
  });

  it('copies the carrier', () => {
    const carrier = { kind: 'makaio.extension', id: 'acme' };
    const call = mintCallContext({ caller, principal }, { carrier });

    carrier.id = 'changed';

    expect(ownCarrierOf(call)).toEqual({ kind: 'makaio.extension', id: 'acme' });
  });
});

// ---------------------------------------------------------------------------
// Deep freezing
// ---------------------------------------------------------------------------

describe('mintCallContext: freezing', () => {
  it('freezes the context, the parties and every nested claim', () => {
    const call = mintCallContext({
      caller: { ...caller, claims: { roles: ['a', ['b']], nested: { deep: { list: [{ x: 1 }] } } } },
      principal: { ...principal, claims: { k: 'v' } },
      attestedBy: { kind: 'acme.idp', id: 'idp', claims: { l: [1] } },
    });

    expect(isDeeplyFrozen(call)).toBe(true);
  });

  it('rejects writes, additions and deletions on the result', () => {
    const call = mintCallContext({ caller: { ...caller, claims: { roles: ['a'] } }, principal });
    const mutable: { caller?: unknown; extra?: unknown; principal?: unknown } = call;

    expect(() => {
      mutable.caller = principal;
    }).toThrow(TypeError);
    expect(() => {
      mutable.extra = 1;
    }).toThrow(TypeError);
    expect(() => {
      delete mutable.principal;
    }).toThrow(TypeError);
    expect(() => {
      (call.caller as { id: string }).id = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (call.caller.claims?.roles as string[]).push('b');
    }).toThrow(TypeError);
    expect(() => {
      (call.caller.claims as Record<string, unknown>).added = 1;
    }).toThrow(TypeError);
    expect(call.caller.id).toBe('u-1');
    expect(call.caller.claims).toEqual({ roles: ['a'] });
  });

  it('freezes the recorded carrier', () => {
    const call = mintCallContext({ caller, principal }, { carrier: { kind: 'makaio.host', id: 'h-1' } });
    const carrier = ownCarrierOf(call);

    expect(Object.isFrozen(carrier)).toBe(true);
  });

  it('accepts a claims tree 5000 levels deep and freezes all of it', () => {
    let claim: unknown = 'leaf';
    for (let level = 0; level < 5000; level++) claim = [claim];
    const call = mintLoose({ caller: { ...caller, claims: { deep: claim } }, principal });

    let node: unknown = call.caller.claims?.deep;
    let depth = 0;
    while (Array.isArray(node)) {
      expect(Object.isFrozen(node)).toBe(true);
      node = node[0];
      depth++;
    }
    expect(depth).toBe(5000);
    expect(node).toBe('leaf');
  });

  it('rejects a claims tree 100000 levels deep with an InvalidCallContextError', () => {
    let claim: unknown = 'leaf';
    for (let level = 0; level < 100_000; level++) claim = [claim];

    expectRejected(() => mintLoose({ caller: { ...caller, claims: { deep: claim } }, principal }), 'caller.claims');
  });
});

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

describe('mintCallContext: rejection', () => {
  it('names the place of each rejected input', () => {
    expectRejected(() => mintLoose(null), 'input');
    expectRejected(() => mintLoose('text'), 'input');
    expectRejected(() => mintLoose([caller, principal]), 'input');
    expectRejected(() => mintLoose({ principal }), 'caller');
    expectRejected(() => mintLoose({ caller }), 'principal');
    expectRejected(() => mintLoose({ caller, principal, attestedBy: 'nobody' }), 'attestedBy');
    expectRejected(() => mintLoose({ caller: 'secret-caller', principal }, undefined), 'caller', 'secret-caller');
  });

  it('rejects an unknown key on the input, a party and the carrier', () => {
    expectRejected(() => mintLoose({ caller, principal, extra: 1 }), 'input');
    expectRejected(() => mintLoose({ caller: { ...caller, extra: 1 }, principal }), 'caller');
    expectRejected(() => mintLoose({ caller, principal: { ...principal, role: 'x' } }), 'principal');
    expectRejected(() => mintLoose({ caller, principal }, { carrier: { kind: 'a.b', id: 'x', extra: 1 } }), 'carrier');
  });

  it('rejects a symbol key on the input and on a party', () => {
    expectRejected(() => mintLoose({ caller, principal, [Symbol('k')]: 1 }), 'input');
    expectRejected(() => mintLoose({ caller: { ...caller, [Symbol('k')]: 1 }, principal }), 'caller');
  });

  it('rejects an accessor on the input, a party and the carrier without running it', () => {
    let ran = 0;
    const getter = {
      get id() {
        ran++;
        return 'u-1';
      },
    };
    const withGetterCaller = Object.defineProperties(
      {},
      {
        kind: { value: 'acme.user', enumerable: true },
        id: Object.getOwnPropertyDescriptor(getter, 'id') ?? {},
      },
    );
    const inputWithGetter = Object.defineProperties(
      { principal },
      {
        caller: {
          get: () => {
            ran++;
            return caller;
          },
          enumerable: true,
        },
      },
    );
    const carrierWithGetter = Object.defineProperties(
      { kind: 'a.b' },
      {
        id: {
          get: () => {
            ran++;
            return 'x';
          },
          enumerable: true,
        },
      },
    );

    expectRejected(() => mintLoose({ caller: withGetterCaller, principal }), 'caller.id');
    expectRejected(() => mintLoose(inputWithGetter), 'input.caller');
    expectRejected(() => mintLoose({ caller, principal }, { carrier: carrierWithGetter }), 'carrier.id');
    expect(ran).toBe(0);
  });

  it('rejects a party that is not a plain object', () => {
    class Person {
      public readonly kind = 'acme.user';
      public readonly id = 'u-1';
    }

    expectRejected(() => mintLoose({ caller: new Person(), principal }), 'caller');
    expectRejected(() => mintLoose({ caller: [caller], principal }), 'caller');
    expectRejected(() => mintLoose({ caller: new Date(), principal }), 'caller');
    expectRejected(() => mintLoose({ caller: () => caller, principal }), 'caller');
    expectRejected(() => mintLoose({ caller: Object.create(caller), principal }), 'caller');
  });

  it('rejects an invalid kind or id with the place of the problem', () => {
    expectRejected(() => mintLoose({ caller: { kind: 'nodot', id: 'u' }, principal }), 'caller', 'nodot');
    expectRejected(() => mintLoose({ caller: { kind: 'trailing.', id: 'u' }, principal }), 'caller');
    expectRejected(() => mintLoose({ caller: { kind: 42, id: 'u' }, principal }), 'caller');
    expectRejected(() => mintLoose({ caller: { kind: 'acme.user', id: '' }, principal }), 'caller');
    expectRejected(() => mintLoose({ caller: { kind: 'acme.user', id: 7 }, principal }), 'caller');
    expectRejected(() => mintLoose({ caller: { kind: 'acme.user' }, principal }), 'caller');
    expectRejected(() => mintLoose({ caller, principal: { kind: 'acme.service', id: '' } }), 'principal');
    expectRejected(() => mintLoose({ caller, principal, attestedBy: { kind: 'bad', id: 'x' } }), 'attestedBy');
  });

  it('rejects an invalid carrier', () => {
    expectRejected(() => mintLoose({ caller, principal }, { carrier: 'host' }), 'carrier');
    expectRejected(() => mintLoose({ caller, principal }, { carrier: { kind: 'nodot', id: 'x' } }), 'carrier');
    expectRejected(() => mintLoose({ caller, principal }, { carrier: { kind: 'a.b', id: '' } }), 'carrier');
    expectRejected(() => mintLoose({ caller, principal }, { carrier: { kind: 'a.b' } }), 'carrier');
  });

  it('does not register a context for a rejected mint', () => {
    const input = { caller, principal, extra: 1 };

    expect(() => mintLoose(input)).toThrow(InvalidCallContextError);
    expect(isMintedCallContext(input)).toBe(false);
  });

  it('is a BusError', () => {
    const error = thrownBy(() => mintLoose(null));

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('name', 'InvalidCallContextError');
  });
});

describe('mintCallContext: rejected claims', () => {
  const withClaims = (claims: unknown) => () => mintLoose({ caller: { ...caller, claims }, principal });

  it('rejects claims that are not a plain object', () => {
    expectRejected(withClaims('text'), 'caller.claims');
    expectRejected(withClaims(['a']), 'caller.claims');
    expectRejected(withClaims(null), 'caller.claims');
    expectRejected(withClaims(new Map()), 'caller.claims');
  });

  it('rejects values that are not JSON-like', () => {
    expectRejected(withClaims({ f: () => 1 }), 'caller.claims', 'never-in-message');
    expectRejected(withClaims({ u: undefined }), 'caller.claims');
    expectRejected(withClaims({ s: Symbol('s') }), 'caller.claims');
    expectRejected(withClaims({ b: 10n }), 'caller.claims');
    expectRejected(withClaims({ n: Number.NaN }), 'caller.claims');
    expectRejected(withClaims({ i: Number.POSITIVE_INFINITY }), 'caller.claims');
    expectRejected(withClaims({ d: new Date() }), 'caller.claims');
    expectRejected(withClaims({ c: new (class Box {})() }), 'caller.claims');
    expectRejected(withClaims({ list: [1, undefined] }), 'caller.claims');
    const holey = [1, 2, 3];
    delete holey[1];
    expectRejected(withClaims({ list: holey }), 'caller.claims');
  });

  it('rejects a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const list: unknown[] = [];
    list.push(list);

    expectRejected(withClaims(cyclic), 'caller.claims');
    expectRejected(withClaims({ list }), 'caller.claims');
  });

  it('rejects an accessor in claims without running it', () => {
    let ran = 0;
    const claims = Object.defineProperty({}, 'trap', {
      get() {
        ran++;
        return 'x';
      },
      enumerable: true,
    });

    expectRejected(withClaims(claims), 'caller.claims');
    expect(ran).toBe(0);
  });

  it('rejects a symbol key and an own __proto__ key in claims', () => {
    expectRejected(withClaims({ [Symbol('k')]: 1 }), 'caller.claims');
    expectRejected(withClaims(JSON.parse('{"__proto__": {"admin": true}}')), 'caller.claims');
  });

  it('rejects invalid claims on the principal and on attestedBy with their own path', () => {
    expectRejected(
      () => mintLoose({ caller, principal: { ...principal, claims: { f: () => 1 } } }),
      'principal.claims',
    );
    expectRejected(
      () => mintLoose({ caller, principal, attestedBy: { kind: 'acme.idp', id: 'i', claims: { f: () => 1 } } }),
      'attestedBy.claims',
    );
  });

  it('accepts every JSON leaf type and a null-prototype claims object', () => {
    const claims = Object.assign(Object.create(null), { s: 'x', n: 1.5, t: true, f: false, z: null, l: [], o: {} });
    const call = mintLoose({ caller: { ...caller, claims }, principal });

    expect(call.caller.claims).toEqual({ s: 'x', n: 1.5, t: true, f: false, z: null, l: [], o: {} });
  });

  it('does not change the prototype of the input claims through a __proto__ lookalike', () => {
    const call = mintLoose({ caller: { ...caller, claims: { constructor: 'x', toString: 'y' } }, principal });

    expect(call.caller.claims).toEqual({ constructor: 'x', toString: 'y' });
    expect(Object.getPrototypeOf(call.caller.claims)).toBe(Object.prototype);
  });
});

// ---------------------------------------------------------------------------
// Own contexts
// ---------------------------------------------------------------------------

describe('ownCarrierOf', () => {
  it('returns the carrier recorded at minting', () => {
    const call = mintCallContext({ caller, principal }, { carrier: { kind: 'makaio.extension', id: 'acme' } });

    expect(ownCarrierOf(call)).toEqual({ kind: 'makaio.extension', id: 'acme' });
  });

  it('returns undefined for a context minted without a carrier', () => {
    expect(ownCarrierOf(mintCallContext({ caller, principal }))).toBeUndefined();
  });

  it('returns undefined for a copy of an own context', () => {
    const call = mintCallContext({ caller, principal }, { carrier: { kind: 'makaio.extension', id: 'acme' } });

    expect(ownCarrierOf({ ...call } as CallContext)).toBeUndefined();
  });

  it('keeps the carrier of one context apart from another', () => {
    const first = mintCallContext({ caller, principal }, { carrier: { kind: 'makaio.extension', id: 'a' } });
    const second = mintCallContext({ caller, principal }, { carrier: { kind: 'makaio.extension', id: 'b' } });

    expect(ownCarrierOf(first)?.id).toBe('a');
    expect(ownCarrierOf(second)?.id).toBe('b');
  });

  it('records only kind and id of a carrier', () => {
    const call = mintCallContext({ caller, principal }, { carrier: { kind: 'makaio.host', id: 'h' } });

    expect(Object.keys(ownCarrierOf(call) ?? {}).sort()).toEqual(['id', 'kind']);
  });
});

describe('ownPurposeOf', () => {
  const carrier = { kind: 'makaio.extension', id: 'acme' };

  it('returns the purpose recorded at minting', () => {
    expect(ownPurposeOf(mintCallContext({ caller, principal }, { carrier, purpose: 'start' }))).toBe('start');
  });

  it('returns undefined for a normal context', () => {
    expect(ownPurposeOf(mintCallContext({ caller, principal }))).toBeUndefined();
  });

  it('returns undefined for an own context minted without a purpose', () => {
    expect(ownPurposeOf(mintCallContext({ caller, principal }, { carrier }))).toBeUndefined();
  });

  it('returns undefined for a copy of an own context', () => {
    const call = mintCallContext({ caller, principal }, { carrier, purpose: 'root' });

    expect(ownPurposeOf({ ...call } as CallContext)).toBeUndefined();
  });

  it('rejects a purpose without a carrier', () => {
    expectRejected(() => mintLoose({ caller, principal }, { purpose: 'start' }), 'purpose');
  });

  it('rejects a value that is not an own work purpose', () => {
    expectRejected(() => mintLoose({ caller, principal }, { carrier, purpose: 'nope' }), 'purpose');
    expectRejected(() => mintLoose({ caller, principal }, { carrier, purpose: 7 }), 'purpose');
    expectRejected(() => mintLoose({ caller, principal }, { carrier, purpose: null }), 'purpose');
  });

  it('keeps two purposes of the same carrier apart', () => {
    const start = mintCallContext({ caller, principal }, { carrier, purpose: 'start' });
    const stop = mintCallContext({ caller, principal }, { carrier, purpose: 'stop' });

    expect(ownPurposeOf(start)).toBe('start');
    expect(ownPurposeOf(stop)).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// Proxy: values that change between reads
// ---------------------------------------------------------------------------

/**
 * Check the one thing a minted context must guarantee for a hostile input: it is rejected, or it is a
 * self-consistent, frozen snapshot that does not move when read again or when the input changes later.
 * @param run - Mint that may succeed or throw.
 * @param afterwards - Hook that changes the hostile input after minting.
 */
function expectRejectedOrStable(run: () => CallContext, afterwards: () => void): void {
  let call: CallContext;
  try {
    call = run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCallContextError);
    return;
  }
  expect(isMintedCallContext(call)).toBe(true);
  expect(isDeeplyFrozen(call)).toBe(true);
  const first = JSON.stringify(call);
  afterwards();
  expect(JSON.stringify(call)).toBe(first);
  expect(JSON.stringify(call)).toBe(first);
  // The values read from the result must be the plain values it was built from.
  const reread = JSON.parse(first) as { caller: { kind: string; id: string } };
  expect(call.caller.kind).toBe(reread.caller.kind);
  expect(call.caller.id).toBe(reread.caller.id);
}

describe('mintCallContext: proxies', () => {
  it('accepts a proxy without traps as a copy of its target, or rejects it', () => {
    const target = { ...caller };
    const proxy = new Proxy(target, {});

    expectRejectedOrStable(
      () => mintLoose({ caller: proxy, principal }),
      () => {
        target.id = 'changed-later';
      },
    );
  });

  it('is stable for a party proxy whose values change on every read', () => {
    let reads = 0;
    const target = { ...caller };
    const hostile = new Proxy(target, {
      get(object, key) {
        reads++;
        return key === 'id' ? `id-${reads}` : Reflect.get(object, key);
      },
      getOwnPropertyDescriptor(object, key) {
        reads++;
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        return descriptor && key === 'id' ? { ...descriptor, value: `desc-${reads}` } : descriptor;
      },
    });

    expectRejectedOrStable(
      () => mintLoose({ caller: hostile, principal }),
      () => {
        reads += 100;
      },
    );
  });

  it('is stable for a party proxy whose key list and prototype change on every read', () => {
    let reads = 0;
    const target = { ...caller };
    const hostile = new Proxy(target, {
      ownKeys(object) {
        reads++;
        return reads % 2 === 0 ? ['kind', 'id', 'claims'] : Reflect.ownKeys(object);
      },
      getPrototypeOf(object) {
        reads++;
        return reads % 2 === 0 ? Object.prototype : Reflect.getPrototypeOf(object);
      },
    });

    expectRejectedOrStable(
      () => mintLoose({ caller: hostile, principal }),
      () => {
        reads++;
      },
    );
  });

  it('is stable for a claims proxy whose values change on every read', () => {
    let reads = 0;
    const target = { role: 'user', list: ['a'] };
    const claims = new Proxy(target, {
      get(object, key) {
        reads++;
        return key === 'role' ? `role-${reads}` : Reflect.get(object, key);
      },
      getOwnPropertyDescriptor(object, key) {
        reads++;
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        return descriptor && key === 'role' ? { ...descriptor, value: `desc-${reads}` } : descriptor;
      },
    });

    expectRejectedOrStable(
      () => mintLoose({ caller: { ...caller, claims }, principal }),
      () => {
        reads += 100;
        target.role = 'admin';
      },
    );
  });

  it('is stable for a claims proxy that is valid on the first read and hostile afterwards', () => {
    let hostile = false;
    const target: Record<string, unknown> = { role: 'user' };
    const claims = new Proxy(target, {
      get(object, key) {
        return hostile && key === 'role' ? { admin: true } : Reflect.get(object, key);
      },
      getOwnPropertyDescriptor(object, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        return hostile && descriptor && key === 'role' ? { ...descriptor, value: { admin: true } } : descriptor;
      },
      ownKeys(object) {
        return hostile ? [...Reflect.ownKeys(object), 'extra'] : Reflect.ownKeys(object);
      },
    });

    expectRejectedOrStable(
      () => mintLoose({ caller: { ...caller, claims }, principal }),
      () => {
        hostile = true;
      },
    );
  });

  it('is stable for a nested claims proxy that changes after the first read', () => {
    let reads = 0;
    const inner = new Proxy(
      { value: 1 },
      {
        get(object, key) {
          reads++;
          return key === 'value' ? reads : Reflect.get(object, key);
        },
        getOwnPropertyDescriptor(object, key) {
          reads++;
          const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
          return descriptor && key === 'value' ? { ...descriptor, value: reads } : descriptor;
        },
      },
    );

    expectRejectedOrStable(
      () => mintLoose({ caller: { ...caller, claims: { inner } }, principal }),
      () => {
        reads += 100;
      },
    );
  });

  it('is stable for an input proxy whose parties change on every read', () => {
    let reads = 0;
    const target = { caller, principal };
    const hostile = new Proxy(target, {
      get(object, key) {
        reads++;
        return key === 'caller' ? { kind: 'acme.user', id: `id-${reads}` } : Reflect.get(object, key);
      },
      getOwnPropertyDescriptor(object, key) {
        reads++;
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        return descriptor && key === 'caller'
          ? { ...descriptor, value: { kind: 'acme.user', id: `desc-${reads}` } }
          : descriptor;
      },
    });

    expectRejectedOrStable(
      () => mintLoose(hostile),
      () => {
        reads += 100;
      },
    );
  });

  it('is stable for a carrier proxy whose values change on every read', () => {
    let reads = 0;
    const hostile = new Proxy(
      { kind: 'makaio.extension', id: 'acme' },
      {
        get(object, key) {
          reads++;
          return key === 'id' ? `id-${reads}` : Reflect.get(object, key);
        },
        getOwnPropertyDescriptor(object, key) {
          reads++;
          const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
          return descriptor && key === 'id' ? { ...descriptor, value: `desc-${reads}` } : descriptor;
        },
      },
    );
    let call: CallContext | undefined;

    try {
      call = mintLoose({ caller, principal }, { carrier: hostile });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCallContextError);
      return;
    }
    const first = JSON.stringify(ownCarrierOf(call));
    reads += 100;
    expect(JSON.stringify(ownCarrierOf(call))).toBe(first);
    expect(Object.isFrozen(ownCarrierOf(call))).toBe(true);
  });
});

import {
  createBusNamespace,
  createNamespaceWildcardSubject,
  type CallContext,
  type Party,
  type PartyRef,
} from '@makaio/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ForeignOwnContextError, implicitOwn, own } from '../call-context/carrier.js';
import { InvalidCallContextError, mintCallContext, ownCarrierOf, ownPurposeOf } from '../call-context/mint.js';
import { isSubjectDefinition, normalizeSendArgs } from '../call-context/send-args.js';
import { enterSend } from '../call-context/send-entry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CARRIER_A: PartyRef = { kind: 'makaio.extension', id: 'send-args-a' };
const CARRIER_B: PartyRef = { kind: 'makaio.extension', id: 'send-args-b' };

/** Shared bus context of the sending instance; own contexts are bound to it. */
const BUS_CONTEXT = {};

const PERSON: Party = { kind: 'acme.person', id: 'person-1' };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };

const { subjects: SUBJECTS } = createBusNamespace('sendArgsTest', {
  ping: z.object({ n: z.number() }),
  getInfo: { request: z.object({ id: z.string() }), response: z.object({ data: z.string() }) },
  'tool.use': z.object({ toolName: z.string() }),
});

/**
 * Mint a received-style context (no carrier record), as a transport delivery would.
 * @returns The minted context.
 */
function receivedContext(): CallContext {
  return mintCallContext({ caller: { kind: 'acme.remote', id: 'remote-1' }, principal: PERSON, attestedBy: ATTESTER });
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
 * Assert that `actual` is a detached, frozen snapshot of `original`: structurally equal, not the same object.
 * @param actual - The subject returned by `normalizeSendArgs`.
 * @param original - The subject that was passed in.
 */
function expectFrozenSnapshotOf(actual: unknown, original: unknown): void {
  expect(actual).toEqual(original);
  expect(actual).not.toBe(original);
  expect(Object.isFrozen(actual)).toBe(true);
}

// ---------------------------------------------------------------------------
// call form
// ---------------------------------------------------------------------------

describe('normalizeSendArgs: call form', () => {
  it('takes call, subject, payload and options from the four arguments', () => {
    const call = receivedContext();
    const payload = { n: 1 };
    const options = { transports: [] };

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [call, SUBJECTS.ping, payload, options]);

    expect(normalized.call).toBe(call);
    expectFrozenSnapshotOf(normalized.subject, SUBJECTS.ping);
    expect(normalized.payload).toBe(payload);
    expect(normalized.options).toBe(options);
  });

  it('accepts an own context of the carrier as the call', () => {
    const call = own(BUS_CONTEXT, CARRIER_A, 'shared-work');

    expect(normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [call, SUBJECTS.ping, { n: 1 }]).call).toBe(call);
  });

  it('does not judge namespace, kind or wildcards of a well-formed subject: that is validateMessage', () => {
    const call = receivedContext();

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'emit', [call, SUBJECTS.$all, {}]);

    expectFrozenSnapshotOf(normalized.subject, SUBJECTS.$all);
  });

  it('rejects a foreign carrier own context through enterSend', () => {
    const foreign = own(BUS_CONTEXT, CARRIER_B, 'start');
    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [foreign, SUBJECTS.ping, { n: 1 }]);

    expect(
      thrownBy(() => enterSend(normalized.call, BUS_CONTEXT, CARRIER_A, normalized.subject.subject)),
    ).toBeInstanceOf(ForeignOwnContextError);
  });
});

// ---------------------------------------------------------------------------
// own form
// ---------------------------------------------------------------------------

describe('normalizeSendArgs: own form', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['event subject', SUBJECTS.ping],
    ['request subject', SUBJECTS.getInfo],
    ['nested subject', SUBJECTS.tool.use],
    ['namespace wildcard subject', SUBJECTS.$all],
    ['standalone wildcard definition', createNamespaceWildcardSubject('other')],
  ];

  it.each(cases)('treats a %s first argument as own form with the implicit own context', (_name, subject) => {
    const payload = { n: 1 };
    const options = { transports: [] };

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [subject, payload, options]);

    expect(normalized.call).toBe(implicitOwn(BUS_CONTEXT, CARRIER_A));
    expectFrozenSnapshotOf(normalized.subject, subject);
    expect(normalized.payload).toBe(payload);
    expect(normalized.options).toBe(options);
  });

  it('pins swapped arguments (subject, minted, payload) as an own-form send whose payload is the context', () => {
    const minted = receivedContext();

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [SUBJECTS.ping, minted, { n: 1 }]);

    expect(normalized.call).toBe(implicitOwn(BUS_CONTEXT, CARRIER_A));
    expectFrozenSnapshotOf(normalized.subject, SUBJECTS.ping);
    expect(normalized.payload).toBe(minted);
    expect(normalized.options).toEqual({ n: 1 });
  });

  it('derives a context with the carrier as caller and principal', () => {
    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [SUBJECTS.ping, { n: 1 }]);

    const sent = enterSend(normalized.call, BUS_CONTEXT, CARRIER_A, normalized.subject.subject);

    expect(sent.caller).toEqual(CARRIER_A);
    expect(sent.principal).toEqual(CARRIER_A);
  });
});

// ---------------------------------------------------------------------------
// rejected first arguments
// ---------------------------------------------------------------------------

describe('normalizeSendArgs: rejected first arguments', () => {
  const minted = receivedContext();
  const answersEveryKey = (value: unknown): unknown =>
    new Proxy({}, { get: () => value, has: () => true, getOwnPropertyDescriptor: () => undefined });

  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['a literal { caller, principal }', { caller: CARRIER_A, principal: CARRIER_A }],
    ['a spread of a minted context', { ...minted }],
    ['a literal with an empty $meta', { caller: CARRIER_A, principal: CARRIER_A, $meta: {} }],
    ['a $meta without subject', { $meta: { namespace: 'x' } }],
    ['a subject without $meta', { subject: 'x.y' }],
    ['a $meta without isRequest', { subject: 'x.y', $meta: { namespace: 'x' } }],
    ['a Proxy around a minted context', new Proxy(minted, {})],
    ['a Proxy that answers every key with a string', answersEveryKey('x')],
    ['a Proxy that answers every key with an object', answersEveryKey({ namespace: 'x', isRequest: false })],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'sendArgsTest.ping'],
  ];

  it.each(cases)('throws InvalidCallContextError for %s', (_name, first) => {
    const error = thrownBy(() =>
      normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [first, SUBJECTS.ping, { n: 1 }]),
    );

    expect(error).toBeInstanceOf(InvalidCallContextError);
    expect((error as Error).message).toContain('neither a minted call context nor a subject definition');
  });

  it('throws for an empty argument list', () => {
    expect(thrownBy(() => normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', []))).toBeInstanceOf(
      InvalidCallContextError,
    );
  });
});

// ---------------------------------------------------------------------------
// the checked subject is the dispatched subject
// ---------------------------------------------------------------------------

/**
 * Build a Proxy over a subject-shaped target that answers the first read of each key with `first`
 * and every later read with `later`.
 * @param first - Answers per key for the first read.
 * @param later - Answers per key for every later read.
 * @returns The flipping proxy.
 */
function flippingProxy(first: Record<string, unknown>, later: Record<string, unknown>): object {
  const reads = new Map<string, number>();
  return new Proxy(
    { ...first },
    {
      get: (_target, key) => {
        if (typeof key !== 'string') return undefined;
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? first[key] : later[key];
      },
    },
  );
}

/**
 * Build a subject-shaped object whose `$meta.namespace` getter answers differently on each read.
 * @returns The subject and a read counter of the namespace getter.
 */
function unstableNamespaceSubject(): { subject: object; reads: () => number } {
  let reads = 0;
  const meta = {
    get namespace(): string {
      reads += 1;
      return reads === 1 ? 'checked' : 'other';
    },
    isRequest: false,
  };
  return { subject: { subject: 'checked.ping', $meta: meta }, reads: () => reads };
}

describe('normalizeSendArgs: the checked subject is the dispatched subject', () => {
  it('reads an unstable $meta.namespace getter once and keeps that answer (own form)', () => {
    const { subject, reads } = unstableNamespaceSubject();

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [subject, { n: 1 }]);

    expect(reads()).toBe(1);
    expect(normalized.subject.$meta.namespace).toBe('checked');
    expect(normalized.subject.$meta.namespace).toBe('checked');
    expect(Object.isFrozen(normalized.subject)).toBe(true);
    expect(Object.isFrozen(normalized.subject.$meta)).toBe(true);
  });

  it('reads an unstable $meta.namespace getter once and keeps that answer (call form)', () => {
    const { subject, reads } = unstableNamespaceSubject();

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [receivedContext(), subject, { n: 1 }]);

    expect(reads()).toBe(1);
    expect(normalized.subject.$meta.namespace).toBe('checked');
    expect(normalized.subject).not.toBe(subject);
    expect(Object.isFrozen(normalized.subject)).toBe(true);
  });

  it.each([
    ['own form', (subject: object) => [subject, { n: 1 }]],
    ['call form', (subject: object) => [receivedContext(), subject, { n: 1 }]],
  ])('keeps the first answers of a Proxy that flips subject and namespace after the first read (%s)', (_name, args) => {
    const meta = flippingProxy({ namespace: 'checked', isRequest: false }, { namespace: 'other', isRequest: true });
    const subject = flippingProxy({ subject: 'checked.ping', $meta: meta }, { subject: 'other.ping', $meta: {} });

    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', args(subject));

    expect(normalized.subject.subject).toBe('checked.ping');
    expect(normalized.subject.$meta.namespace).toBe('checked');
    expect(normalized.subject.$meta.isRequest).toBe(false);
    expect(Object.isFrozen(normalized.subject)).toBe(true);
  });

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    [
      'a throwing subject getter',
      {
        get subject(): string {
          throw new Error('boom: subject');
        },
        $meta: { namespace: 'x', isRequest: false },
      },
    ],
    [
      'a throwing $meta getter',
      {
        subject: 'x.y',
        get $meta(): object {
          throw new Error('boom: $meta');
        },
      },
    ],
    [
      'a throwing $meta.namespace getter',
      {
        subject: 'x.y',
        $meta: {
          get namespace(): string {
            throw new Error('boom: namespace');
          },
          isRequest: false,
        },
      },
    ],
    ['a revoked Proxy', revoked.proxy],
  ];

  it.each(hostile)('throws InvalidCallContextError, not the foreign exception, for %s', (_name, first) => {
    const error = thrownBy(() => normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', [first, { n: 1 }]));

    expect(error).toBeInstanceOf(InvalidCallContextError);
    expect(isSubjectDefinition(first)).toBe(false);
  });

  const revokedSecond = Proxy.revocable({}, {});
  revokedSecond.revoke();

  const invalidSecond: ReadonlyArray<readonly [string, unknown]> = [
    ['a string literal', 'sendArgsTest.ping'],
    ['undefined', undefined],
    ['an object with only $meta', { $meta: { namespace: 'sendArgsTest', isRequest: false } }],
    [
      'an object whose $meta getter throws',
      {
        subject: 'x.y',
        get $meta(): object {
          throw new Error('boom: $meta');
        },
      },
    ],
    ['a revoked Proxy', revokedSecond.proxy],
  ];

  describe.each(['emit', 'request'] as const)('call form with a non-subject second argument (%s)', (method) => {
    it.each(invalidSecond)(`throws the invalid-subject error naming ${method}() for %s`, (_name, second) => {
      const error = thrownBy(() => normalizeSendArgs(BUS_CONTEXT, CARRIER_A, method, [receivedContext(), second, {}]));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidCallContextError);
      expect((error as Error).message).toBe(`Invalid subject definition provided to ${method}()`);
    });
  });

  it('rejects a call-form subject whose $meta.namespace getter throws first and answers afterwards, and never reads it again', () => {
    let reads = 0;
    const second = {
      subject: 'sendArgsTest.ping',
      $meta: {
        get namespace(): string {
          reads += 1;
          if (reads === 1) throw new Error('boom: namespace');
          return reads === 2 ? 'sendArgsTest' : 'other';
        },
        isRequest: false,
      },
    };

    const error = thrownBy(() => normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'emit', [receivedContext(), second, {}]));

    expect((error as Error).message).toBe('Invalid subject definition provided to emit()');
    expect(reads).toBe(1);
  });

  it.each([
    ['own form', SUBJECTS.ping, (subject: unknown) => [subject, { n: 1 }]],
    ['call form', SUBJECTS.ping, (subject: unknown) => [receivedContext(), subject, { n: 1 }]],
  ])('never returns the passed subject object (%s)', (_name, subject, args) => {
    const normalized = normalizeSendArgs(BUS_CONTEXT, CARRIER_A, 'request', args(subject));

    expect(normalized.subject).not.toBe(subject);
    expect(normalized.subject.$meta).not.toBe(SUBJECTS.ping.$meta);
  });
});

// ---------------------------------------------------------------------------
// isSubjectDefinition
// ---------------------------------------------------------------------------

describe('isSubjectDefinition', () => {
  it('accepts built subjects and rejects a minted context', () => {
    expect(isSubjectDefinition(SUBJECTS.ping)).toBe(true);
    expect(isSubjectDefinition(SUBJECTS.$all)).toBe(true);
    expect(isSubjectDefinition(receivedContext())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// implicitOwn
// ---------------------------------------------------------------------------

describe('implicitOwn', () => {
  it('is the same context for the same carrier', () => {
    expect(implicitOwn(BUS_CONTEXT, CARRIER_A)).toBe(implicitOwn(BUS_CONTEXT, { ...CARRIER_A }));
  });

  it('differs between carriers that differ only in id', () => {
    expect(implicitOwn(BUS_CONTEXT, CARRIER_A)).not.toBe(implicitOwn(BUS_CONTEXT, CARRIER_B));
  });

  it('has no purpose, records its carrier and is never an own(carrier, purpose) context', () => {
    const implicit = implicitOwn(BUS_CONTEXT, CARRIER_A);

    expect(ownPurposeOf(implicit)).toBeUndefined();
    expect(ownCarrierOf(implicit)).toEqual(CARRIER_A);
    expect(implicit).not.toBe(own(BUS_CONTEXT, CARRIER_A, 'root'));
  });
});

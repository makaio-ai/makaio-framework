import type { CallContext, OwnWorkPurpose, Party, PartyRef, TransportReceiveContext } from '@makaio/core';
import { createBusNamespace } from '@makaio/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCarrierBus } from '../bus-instance.js';
import { createBusInstance } from '../bus.js';
import {
  assertCallCarrier,
  deriveSent,
  ForeignOwnContextError,
  hostPartyOf,
  implicitOwn,
  own,
} from '../call-context/carrier.js';
import {
  InvalidCallContextError,
  isMintedCallContext,
  mintCallContext,
  ownCarrierOf,
  ownPurposeOf,
} from '../call-context/mint.js';
import { __resetWireReports, callFromReceive, wireMetadataOf } from '../call-context/wire.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUS_CONTEXT = {};

const CARRIER_A: PartyRef = { kind: 'makaio.extension', id: 'carrier-a' };
const CARRIER_B: PartyRef = { kind: 'makaio.extension', id: 'carrier-b' };

const PERSON: Party = { kind: 'acme.person', id: 'person-1', claims: { role: 'admin' } };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };

/**
 * Mint a received-style context (no carrier record), as a transport delivery would.
 * @param input - Caller, principal and optional attestation.
 * @returns The minted context.
 */
function receivedContext(input: { caller: Party; principal: Party; attestedBy?: Party }): CallContext {
  return mintCallContext(input);
}

/**
 * Present a plain object as a call context; it was never minted, so the core must refuse it.
 * @param value - Any value standing in for a context.
 * @returns The value typed as a context.
 */
function forgedContext(value: unknown): CallContext {
  return value as CallContext;
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
 * Build a collecting report sink.
 * @returns The sink and the lines it collected.
 */
function collector(): { report: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    report: (message) => {
      lines.push(message);
    },
    lines,
  };
}

// ---------------------------------------------------------------------------
// own
// ---------------------------------------------------------------------------

describe('own', () => {
  it('rejects an own context sent by the same extension on another bus context', async () => {
    const first = createCarrierBus(createBusInstance(), CARRIER_A);
    const second = createCarrierBus(createBusInstance(), { ...CARRIER_A });
    const { subjects } = second.registerNamespace(createBusNamespace('carrierBinding', { changed: z.object({}) }));

    await expect(second.emit(first.own('start'), subjects.changed, {})).rejects.toThrow(ForeignOwnContextError);
  });

  it('reuses an own context for the same extension, bus context and purpose', () => {
    const host = createBusInstance();
    const first = createCarrierBus(host, CARRIER_A);
    const second = createCarrierBus(host, { ...CARRIER_A });

    expect(first.own('start')).toBe(second.own('start'));
  });

  it('returns the same context for the same carrier and purpose', () => {
    expect(own(BUS_CONTEXT, CARRIER_A, 'start')).toBe(own(BUS_CONTEXT, { ...CARRIER_A }, 'start'));
  });

  it('returns distinct contexts for distinct purposes', () => {
    expect(own(BUS_CONTEXT, CARRIER_A, 'start')).not.toBe(own(BUS_CONTEXT, CARRIER_A, 'stop'));
  });

  it('returns distinct contexts for distinct carriers with the same purpose', () => {
    expect(own(BUS_CONTEXT, CARRIER_A, 'schedule')).not.toBe(own(BUS_CONTEXT, CARRIER_B, 'schedule'));
  });

  it('mints a registered context whose caller and principal are the carrier and whose carrier is recorded', () => {
    const call = own(BUS_CONTEXT, CARRIER_A, 'root');
    expect(isMintedCallContext(call)).toBe(true);
    expect(call.caller).toEqual(CARRIER_A);
    expect(call.principal).toEqual(CARRIER_A);
    expect(call.attestedBy).toBeUndefined();
    expect(ownCarrierOf(call)).toEqual(CARRIER_A);
  });

  it('does not confuse carriers whose kind and id concatenate to the same text', () => {
    const left = own(BUS_CONTEXT, { kind: 'acme.a', id: 'b.c' }, 'start');
    const right = own(BUS_CONTEXT, { kind: 'acme.a.b', id: 'c' }, 'start');
    expect(left).not.toBe(right);
  });
});

// ---------------------------------------------------------------------------
// implicitOwn
// ---------------------------------------------------------------------------

describe('implicitOwn', () => {
  const ALL_PURPOSES: readonly OwnWorkPurpose[] = ['start', 'stop', 'schedule', 'observer', 'shared-work', 'root'];

  it('returns the same context for the same carrier, also given as a different object', () => {
    expect(implicitOwn(BUS_CONTEXT, CARRIER_A)).toBe(implicitOwn(BUS_CONTEXT, { ...CARRIER_A }));
  });

  it('returns distinct contexts for carriers that differ only in id', () => {
    expect(implicitOwn(BUS_CONTEXT, CARRIER_A)).not.toBe(implicitOwn(BUS_CONTEXT, CARRIER_B));
  });

  it('returns distinct contexts for carriers that differ only in kind', () => {
    const otherKind = { kind: 'makaio.host', id: CARRIER_A.id };
    expect(implicitOwn(BUS_CONTEXT, CARRIER_A)).not.toBe(implicitOwn(BUS_CONTEXT, otherKind));
  });

  it('does not confuse carriers whose kind and id concatenate to the same text', () => {
    const left = implicitOwn(BUS_CONTEXT, { kind: 'acme.a', id: 'b.c' });
    const right = implicitOwn(BUS_CONTEXT, { kind: 'acme.a.b', id: 'c' });
    expect(left).not.toBe(right);
  });

  it.each(ALL_PURPOSES)('is never identical to own(carrier, %s)', (purpose) => {
    expect(implicitOwn(BUS_CONTEXT, CARRIER_A)).not.toBe(own(BUS_CONTEXT, CARRIER_A, purpose));
  });

  it('has no purpose', () => {
    expect(ownPurposeOf(implicitOwn(BUS_CONTEXT, CARRIER_A))).toBeUndefined();
    expect(ownPurposeOf(own(BUS_CONTEXT, CARRIER_A, 'root'))).toBe('root');
  });

  it('mints a frozen registered context whose caller and principal are the carrier and whose carrier is recorded', () => {
    const call = implicitOwn(BUS_CONTEXT, CARRIER_A);
    expect(isMintedCallContext(call)).toBe(true);
    expect(Object.isFrozen(call)).toBe(true);
    expect(call.caller).toEqual(CARRIER_A);
    expect(call.principal).toEqual(CARRIER_A);
    expect(call.attestedBy).toBeUndefined();
    expect(ownCarrierOf(call)).toEqual(CARRIER_A);
  });

  it('is accepted by assertCallCarrier for its carrier and rejected for a foreign carrier', () => {
    const call = implicitOwn(BUS_CONTEXT, CARRIER_A);
    expect(() => assertCallCarrier(call, CARRIER_A, BUS_CONTEXT)).not.toThrow();
    const error = thrownBy(() => assertCallCarrier(call, CARRIER_B, BUS_CONTEXT));
    expect(error).toBeInstanceOf(ForeignOwnContextError);
    const { message } = error as ForeignOwnContextError;
    expect(message).toContain('makaio.extension:carrier-a');
    expect(message).toContain('makaio.extension:carrier-b');
  });
});

// ---------------------------------------------------------------------------
// deriveSent
// ---------------------------------------------------------------------------

describe('deriveSent', () => {
  it('replaces the caller with the carrier and keeps principal and attestedBy', () => {
    const received = receivedContext({
      caller: { kind: 'acme.client', id: 'someone-else' },
      principal: PERSON,
      attestedBy: ATTESTER,
    });
    const sent = deriveSent(received, BUS_CONTEXT, CARRIER_A);
    expect(sent.caller).toEqual(CARRIER_A);
    expect(sent.principal).toEqual(PERSON);
    expect(sent.attestedBy).toEqual(ATTESTER);
    expect(isMintedCallContext(sent)).toBe(true);
  });

  it('returns a newly minted context, not the passed one', () => {
    const received = receivedContext({ caller: ATTESTER, principal: PERSON });
    const sent = deriveSent(received, BUS_CONTEXT, CARRIER_A);
    expect(sent).not.toBe(received);
    expect(received.caller).toEqual(ATTESTER);
  });

  it('leaves attestedBy absent when the passed context has none', () => {
    const sent = deriveSent(receivedContext({ caller: ATTESTER, principal: PERSON }), BUS_CONTEXT, CARRIER_A);
    expect('attestedBy' in sent).toBe(false);
  });

  it('turns the own context of the same carrier into a context with that carrier as caller and principal', () => {
    const sent = deriveSent(own(BUS_CONTEXT, CARRIER_A, 'start'), BUS_CONTEXT, CARRIER_A);
    expect(sent.caller).toEqual(CARRIER_A);
    expect(sent.principal).toEqual(CARRIER_A);
    expect(ownCarrierOf(sent)).toBeUndefined();
  });

  it('never reads the caller of the passed context', () => {
    const received = receivedContext({ caller: ATTESTER, principal: PERSON });
    const reads: string[] = [];
    const watched = new Proxy(received, {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    // A proxy is not minted: the check rejects it before anything is read.
    expect(() => deriveSent(watched, BUS_CONTEXT, CARRIER_A)).toThrow(InvalidCallContextError);
    expect(reads).not.toContain('caller');
  });

  it('rejects the own context of another carrier', () => {
    const foreign = own(BUS_CONTEXT, CARRIER_B, 'start');
    expect(() => deriveSent(foreign, BUS_CONTEXT, CARRIER_A)).toThrow(ForeignOwnContextError);
  });

  it('rejects a value that was not minted by the core', () => {
    const forged = forgedContext({ caller: CARRIER_A, principal: PERSON });
    expect(() => deriveSent(forged, BUS_CONTEXT, CARRIER_A)).toThrow(InvalidCallContextError);
  });
});

// ---------------------------------------------------------------------------
// assertCallCarrier
// ---------------------------------------------------------------------------

describe('assertCallCarrier', () => {
  it('accepts the own context of the same carrier', () => {
    expect(() => assertCallCarrier(own(BUS_CONTEXT, CARRIER_A, 'observer'), CARRIER_A, BUS_CONTEXT)).not.toThrow();
  });

  it('accepts the same carrier given as a different object', () => {
    expect(() =>
      assertCallCarrier(own(BUS_CONTEXT, CARRIER_A, 'observer'), { ...CARRIER_A }, BUS_CONTEXT),
    ).not.toThrow();
  });

  it('rejects the own context of another carrier with both carriers named and no claims', () => {
    const error = thrownBy(() => assertCallCarrier(own(BUS_CONTEXT, CARRIER_A, 'stop'), CARRIER_B, BUS_CONTEXT));
    expect(error).toBeInstanceOf(ForeignOwnContextError);
    const { message } = error as ForeignOwnContextError;
    expect(message).toContain('makaio.extension:carrier-a');
    expect(message).toContain('makaio.extension:carrier-b');
  });

  it('rejects a carrier of the same id but another kind', () => {
    const sameIdOtherKind: PartyRef = { kind: 'makaio.host', id: CARRIER_A.id };
    const call = own(BUS_CONTEXT, CARRIER_A, 'stop');
    expect(() => assertCallCarrier(call, sameIdOtherKind, BUS_CONTEXT)).toThrow(ForeignOwnContextError);
  });

  it('accepts a received context for any carrier', () => {
    const received = receivedContext({ caller: ATTESTER, principal: PERSON });
    expect(ownCarrierOf(received)).toBeUndefined();
    expect(() => assertCallCarrier(received, CARRIER_A, BUS_CONTEXT)).not.toThrow();
    expect(() => assertCallCarrier(received, CARRIER_B, BUS_CONTEXT)).not.toThrow();
  });

  it('rejects an unminted value', () => {
    const forged = forgedContext({ caller: CARRIER_A, principal: CARRIER_A });
    expect(() => assertCallCarrier(forged, CARRIER_A, BUS_CONTEXT)).toThrow(InvalidCallContextError);
  });

  it('rejects a value assembled from a real context via Object.assign, not registered in the WeakSet', () => {
    const real = receivedContext({ caller: ATTESTER, principal: PERSON });
    const assigned = forgedContext(Object.assign({}, real, { principal: ATTESTER }));
    expect(() => assertCallCarrier(assigned, CARRIER_A, BUS_CONTEXT)).toThrow(InvalidCallContextError);
  });

  it('rejects structuredClone of a real context, which copies the fields but not the WeakSet registration', () => {
    const real = receivedContext({ caller: ATTESTER, principal: PERSON });
    const cloned = forgedContext(structuredClone(real));
    expect(cloned).not.toBe(real);
    expect(cloned).toEqual(real);
    expect(() => assertCallCarrier(cloned, CARRIER_A, BUS_CONTEXT)).toThrow(InvalidCallContextError);
  });
});

// ---------------------------------------------------------------------------
// hostPartyOf
// ---------------------------------------------------------------------------

describe('hostPartyOf', () => {
  it('returns the same party for the same context object', () => {
    const context = {};
    expect(hostPartyOf(context)).toBe(hostPartyOf(context));
  });

  it('returns a distinct party with a distinct id for each context object', () => {
    const first = hostPartyOf({});
    const second = hostPartyOf({});
    expect(first).not.toBe(second);
    expect(first.id).not.toBe(second.id);
  });

  it('is of kind makaio.host with a non-empty id and is frozen', () => {
    const party = hostPartyOf({});
    expect(party.kind).toBe('makaio.host');
    expect(party.id.length).toBeGreaterThan(0);
    expect(Object.isFrozen(party)).toBe(true);
  });

  it('can be the carrier of an own context', () => {
    const context = {};
    const host = hostPartyOf(context);
    const call = own(context, host, 'root');
    expect(call.caller).toEqual({ kind: host.kind, id: host.id });
    expect(() => deriveSent(call, context, host)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// wireMetadataOf
// ---------------------------------------------------------------------------

describe('wireMetadataOf', () => {
  const ownHost: PartyRef = { kind: 'makaio.host', id: 'host-1' };

  it('is undefined when the principal is the own host', () => {
    const call = mintCallContext({ caller: ownHost, principal: { ...ownHost } });
    expect(wireMetadataOf(call, ownHost)).toBeUndefined();
  });

  it('carries the principal as kind and id only, never claims', () => {
    const call = receivedContext({ caller: ATTESTER, principal: PERSON });
    const metadata = wireMetadataOf(call, ownHost);
    expect(metadata).toEqual({ principal: { kind: 'acme.person', id: 'person-1' } });
    expect(metadata?.principal).not.toHaveProperty('claims');
  });

  it('carries the principal of another host that has the same id but another kind', () => {
    const call = mintCallContext({
      caller: ownHost,
      principal: { kind: 'makaio.extension', id: ownHost.id },
    });
    expect(wireMetadataOf(call, ownHost)).toEqual({ principal: { kind: 'makaio.extension', id: ownHost.id } });
  });
});

// ---------------------------------------------------------------------------
// callFromReceive
// ---------------------------------------------------------------------------

describe('callFromReceive', () => {
  beforeEach(() => {
    __resetWireReports?.();
  });

  const receive = (overrides: Partial<TransportReceiveContext> = {}): TransportReceiveContext => ({
    transportName: 'ws',
    connectionId: 'conn-1',
    ...overrides,
  });

  it('uses the caller of the receive context and makes it the principal', () => {
    const { report, lines } = collector();
    const call = callFromReceive(receive({ caller: ATTESTER }), undefined, undefined, report);
    expect(call.caller).toEqual(ATTESTER);
    expect(call.principal).toEqual(ATTESTER);
    expect(call.attestedBy).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('falls back to the declared caller, then to the anonymous caller named by the connection', () => {
    const { report } = collector();
    expect(callFromReceive(receive(), ATTESTER, undefined, report).caller).toEqual(ATTESTER);
    expect(callFromReceive(receive(), undefined, undefined, report).caller).toEqual({
      kind: 'makaio.anonymous',
      id: 'conn-1',
    });
    expect(callFromReceive(receive({ connectionId: undefined }), undefined, undefined, report).caller).toEqual({
      kind: 'makaio.anonymous',
      id: 'ws',
    });
    expect(callFromReceive(undefined, undefined, undefined, report).caller).toEqual({
      kind: 'makaio.anonymous',
      id: 'unknown',
    });
  });

  it('takes the principal from valid metadata and records the caller as attestedBy', () => {
    const { report } = collector();
    const call = callFromReceive(
      receive({ caller: ATTESTER, attests: 'inbound' }),
      undefined,
      { principal: { kind: 'acme.person', id: 'person-2' } },
      report,
    );
    expect(call.caller).toEqual(ATTESTER);
    expect(call.principal).toEqual({ kind: 'acme.person', id: 'person-2' });
    expect(call.attestedBy).toEqual(ATTESTER);
  });

  it('keeps the caller as principal for metadata without a principal', () => {
    const { report, lines } = collector();
    const call = callFromReceive(receive({ caller: ATTESTER }), undefined, {}, report);
    expect(call.principal).toEqual(ATTESTER);
    expect(call.attestedBy).toBeUndefined();
    expect(lines).toEqual([]);
  });

  describe('downgrade of in-process kinds', () => {
    it.each(['makaio.extension', 'makaio.host'])('treats a delivered caller of kind %s as anonymous', (kind) => {
      const { report } = collector();
      const call = callFromReceive(receive({ caller: { kind, id: 'forged' } }), undefined, undefined, report);
      expect(call.caller).toEqual({ kind: 'makaio.anonymous', id: 'conn-1' });
      expect(call.principal).toEqual({ kind: 'makaio.anonymous', id: 'conn-1' });
    });

    it('treats a declared caller of an in-process kind as anonymous', () => {
      const { report, lines } = collector();
      const call = callFromReceive(receive(), { kind: 'makaio.host', id: 'declared' }, undefined, report);
      expect(call.caller.kind).toBe('makaio.anonymous');
      expect(lines).toHaveLength(1);
    });

    it('reports exactly once per connection and claimed kind', () => {
      const { report, lines } = collector();
      const forged = receive({ caller: { kind: 'makaio.extension', id: 'forged' } });
      callFromReceive(forged, undefined, undefined, report);
      callFromReceive(forged, undefined, undefined, report);
      callFromReceive(forged, undefined, undefined, report);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('makaio.extension');
      expect(lines[0]).toContain('conn-1');

      // Another claimed kind on the same connection is a new report.
      callFromReceive(receive({ caller: { kind: 'makaio.host', id: 'forged' } }), undefined, undefined, report);
      expect(lines).toHaveLength(2);

      // The same kind on another connection is a new report.
      callFromReceive(
        receive({ connectionId: 'conn-2', caller: { kind: 'makaio.extension', id: 'forged' } }),
        undefined,
        undefined,
        report,
      );
      expect(lines).toHaveLength(3);
    });

    it('does not read the claimed id into the anonymous caller', () => {
      const { report } = collector();
      const call = callFromReceive(
        receive({ caller: { kind: 'makaio.host', id: 'secret-forged-id' } }),
        undefined,
        undefined,
        report,
      );
      expect(JSON.stringify(call.caller)).not.toContain('secret-forged-id');
    });
  });

  describe('invalid metadata', () => {
    it.each([
      ['a string', 'principal'],
      ['a number', 7],
      ['null', null],
      ['an unknown key', { principal: { kind: 'acme.person', id: 'p' }, extra: true }],
      ['a principal with claims', { principal: { kind: 'acme.person', id: 'p', claims: { a: 1 } } }],
      ['a principal with a malformed kind', { principal: { kind: 'no-dot', id: 'p' } }],
      ['a principal with an empty id', { principal: { kind: 'acme.person', id: '' } }],
    ])('drops metadata that is %s and keeps the caller as principal', (_label, metadata) => {
      const { report, lines } = collector();
      const call = callFromReceive(receive({ caller: ATTESTER }), undefined, metadata, report);
      expect(call.principal).toEqual(ATTESTER);
      expect(call.attestedBy).toBeUndefined();
      expect(lines).toHaveLength(1);
    });

    it('reports dropped metadata once per connection', () => {
      const { report, lines } = collector();
      const input = receive({ caller: ATTESTER });
      callFromReceive(input, undefined, 'bad', report);
      callFromReceive(input, undefined, { principal: 5 }, report);
      expect(lines).toHaveLength(1);
      callFromReceive(receive({ connectionId: 'conn-2', caller: ATTESTER }), undefined, 'bad', report);
      expect(lines).toHaveLength(2);
    });

    it('does not report valid metadata', () => {
      const { report, lines } = collector();
      callFromReceive(
        receive({ caller: ATTESTER, attests: 'inbound' }),
        undefined,
        { principal: { kind: 'acme.person', id: 'p' } },
        report,
      );
      expect(lines).toEqual([]);
    });
  });

  it('delivers a context that a carrier can pass on but that is no own context', () => {
    const { report } = collector();
    const call = callFromReceive(receive({ caller: ATTESTER }), undefined, undefined, report);
    expect(isMintedCallContext(call)).toBe(true);
    expect(ownCarrierOf(call)).toBeUndefined();
    expect(() => assertCallCarrier(call, CARRIER_A, BUS_CONTEXT)).not.toThrow();
  });
});

import { createBusNamespace } from '@makaio/core';
import type { CallContext, Party, PartyRef } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '../bus.js';
import { busContextOf, createCarrierBus } from '../bus-instance.js';
import { ForeignOwnContextError } from '../call-context/carrier.js';
import { InvalidCallContextError, mintCallContext } from '../call-context/mint.js';
import { __resetOwnWork, getOwnCallReport } from '../call-context/own-work.js';
import { emitReceived } from '../methods/emit.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'MAKAIO_OWN_CALL_REPORT';

const CARRIER_A: PartyRef = { kind: 'makaio.extension', id: 'send-test-a' };
const CARRIER_B: PartyRef = { kind: 'makaio.extension', id: 'send-test-b' };

const PERSON: Party = { kind: 'acme.person', id: 'person-1' };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };
/** A caller that is neither carrier: a send that keeps it forwarded the passed context unchanged. */
const OTHER_CALLER: Party = { kind: 'acme.other', id: 'other-1' };

/**
 * Mint a received-style context (no carrier record) whose caller is neither carrier.
 * @returns The minted context.
 */
function passedCall(): CallContext {
  return mintCallContext({ caller: OTHER_CALLER, principal: PERSON, attestedBy: ATTESTER });
}

/**
 * Register a fresh namespace on a bus and return it, with an event, a request and a broadcast-capable request subject.
 * @param bus - Bus to register on (any carrier instance of a host works: one shared registry).
 * @param name - Unique namespace name.
 * @returns The registered namespace.
 */
function registerNamespaceOn(bus: ReturnType<typeof createBusInstance>, name: string) {
  return bus.registerNamespace(
    createBusNamespace(name, {
      changed: z.object({ id: z.string() }),
      load: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
      announce: { request: z.object({ id: z.string() }), response: z.object({ ack: z.boolean() }) },
      other: z.object({ id: z.string() }),
    }),
  );
}

/**
 * Register a fresh namespace and return only its subjects.
 * @param bus - Bus to register on.
 * @param name - Unique namespace name.
 * @returns The subjects of the namespace.
 */
function registerSubjects(bus: ReturnType<typeof createBusInstance>, name: string) {
  return registerNamespaceOn(bus, name).subjects;
}

let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetOwnWork?.();
});

afterEach(() => {
  if (savedMode === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedMode;
  __resetOwnWork?.();
});

// ---------------------------------------------------------------------------
// Caller of the delivered message is the carrier
// ---------------------------------------------------------------------------

describe('send through a carrier-bound bus instance', () => {
  it('delivers an emit with the carrier as caller and keeps principal and attestedBy', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendEmit');
    const seen: CallContext[] = [];
    host.on(subjects.changed, (ctx) => {
      seen.push(ctx.call);
    });

    await busA.emit(passedCall(), subjects.changed, { id: '1' });

    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toEqual(CARRIER_A);
    expect(seen[0].principal).toEqual(PERSON);
    expect(seen[0].attestedBy).toEqual(ATTESTER);
  });

  it('delivers a request with the carrier as caller and keeps principal and attestedBy', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendRequest');
    const seen: CallContext[] = [];
    host.on(subjects.load, (ctx) => {
      seen.push(ctx.call);
      ctx.setResult({ ok: true });
    });

    const result = await busA.request(passedCall(), subjects.load, { id: '1' });

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toEqual(CARRIER_A);
    expect(seen[0].principal).toEqual(PERSON);
    expect(seen[0].attestedBy).toEqual(ATTESTER);
  });

  it('delivers a requestOptional with the carrier as caller', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendRequestOptional');
    const seen: CallContext[] = [];
    host.on(subjects.load, (ctx) => {
      seen.push(ctx.call);
      ctx.setResult({ ok: true });
    });

    await busA.requestOptional(passedCall(), subjects.load, { id: '1' });

    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toEqual(CARRIER_A);
    expect(seen[0].principal).toEqual(PERSON);
  });

  it('delivers a broadcast with the carrier as caller and keeps principal and attestedBy', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendBroadcast');
    const seen: CallContext[] = [];
    host.on(subjects.announce, (ctx) => {
      seen.push(ctx.call);
      ctx.setResult({ ack: true });
    });

    await busA.broadcast(passedCall(), subjects.announce, { id: '1' });

    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toEqual(CARRIER_A);
    expect(seen[0].principal).toEqual(PERSON);
    expect(seen[0].attestedBy).toEqual(ATTESTER);
  });

  it('keeps the carrier through a scoped view (emit and request)', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const namespace = registerNamespaceOn(host, 'sendScoped');
    const subjects = namespace.subjects;
    const seen: CallContext[] = [];
    host.on(subjects.changed, (ctx) => {
      seen.push(ctx.call);
    });
    host.on(subjects.load, (ctx) => {
      seen.push(ctx.call);
      ctx.setResult({ ok: true });
    });

    const scoped = busA.scoped(namespace);
    await scoped.emit(passedCall(), subjects.changed, { id: '1' });
    await scoped.request(passedCall(), subjects.load, { id: '1' });

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.caller).toEqual(CARRIER_A);
      expect(call.principal).toEqual(PERSON);
      expect(call.attestedBy).toEqual(ATTESTER);
    }
  });

  it('keeps the carrier through a filtered view (emit and request)', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const namespace = registerNamespaceOn(host, 'sendFiltered');
    const subjects = namespace.subjects;
    const seen: CallContext[] = [];
    host.on(subjects.changed, (ctx) => {
      seen.push(ctx.call);
    });
    host.on(subjects.load, (ctx) => {
      seen.push(ctx.call);
      ctx.setResult({ ok: true });
    });

    const filtered = busA.scoped(namespace).withFilter({ id: '1' });
    await filtered.emit(passedCall(), subjects.changed, { id: '1' });
    await filtered.request(passedCall(), subjects.load, { id: '1' });

    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.caller).toEqual(CARRIER_A);
      expect(call.principal).toEqual(PERSON);
      expect(call.attestedBy).toEqual(ATTESTER);
    }
  });

  it('keeps the carrier through a filtered view taken straight from the bus', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendDirectFilter');
    const seen: CallContext[] = [];
    host.on(subjects.changed, (ctx) => {
      seen.push(ctx.call);
    });

    await busA.withFilter({ id: '1' }).emit(passedCall(), subjects.changed, { id: '1' });

    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toEqual(CARRIER_A);
  });

  it('gives the host instance its own host party as caller, different from an extension carrier', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendHostCaller');
    const callers: Party[] = [];
    host.on(subjects.changed, (ctx) => {
      callers.push(ctx.call.caller);
    });

    await host.emit(host.own('start'), subjects.changed, { id: '1' });
    await busA.emit(busA.own('start'), subjects.changed, { id: '2' });

    expect(callers[0].kind).toBe('makaio.host');
    expect(callers[1]).toEqual(CARRIER_A);
  });
});

// ---------------------------------------------------------------------------
// Sending on from a handler
// ---------------------------------------------------------------------------

describe('a handler that sends on with ctx.call', () => {
  it('keeps the original principal and becomes the caller of the next message', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const subjects = registerSubjects(host, 'sendOn');

    const downstream: CallContext[] = [];
    host.on(subjects.other, (ctx) => {
      downstream.push(ctx.call);
    });
    // Handler of carrier B receives the message of A and sends on through its own bus.
    busB.on(subjects.changed, async (ctx) => {
      await busB.emit(ctx.call, subjects.other, { id: ctx.payload.id });
    });

    await busA.emit(passedCall(), subjects.changed, { id: '1' });

    expect(downstream).toHaveLength(1);
    expect(downstream[0].caller).toEqual(CARRIER_B);
    expect(downstream[0].principal).toEqual(PERSON);
    expect(downstream[0].attestedBy).toEqual(ATTESTER);
  });

  it('sees the sender as caller of the received ctx.call', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const subjects = registerSubjects(host, 'sendReceived');
    const received: CallContext[] = [];
    busB.on(subjects.changed, (ctx) => {
      received.push(ctx.call);
    });

    await busA.emit(passedCall(), subjects.changed, { id: '1' });

    expect(received).toHaveLength(1);
    expect(received[0].caller).toEqual(CARRIER_A);
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe('rejected calls', () => {
  it('rejects the own context of another carrier on emit, request and broadcast', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const subjects = registerSubjects(host, 'sendForeign');
    const delivered: string[] = [];
    host.on(subjects.changed, () => {
      delivered.push('changed');
    });
    host.on(subjects.load, (ctx) => {
      delivered.push('load');
      ctx.setResult({ ok: true });
    });
    host.on(subjects.announce, (ctx) => {
      delivered.push('announce');
      ctx.setResult({ ack: true });
    });

    const foreign = busB.own('start');
    await expect(busA.emit(foreign, subjects.changed, { id: '1' })).rejects.toBeInstanceOf(ForeignOwnContextError);
    await expect(busA.request(foreign, subjects.load, { id: '1' })).rejects.toBeInstanceOf(ForeignOwnContextError);
    await expect(busA.broadcast(foreign, subjects.announce, { id: '1' })).rejects.toBeInstanceOf(
      ForeignOwnContextError,
    );
    expect(delivered).toEqual([]);
  });

  it('rejects the own context of the host and of a foreign instance on an extension bus', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendForeignHost');

    await expect(busA.emit(host.own('root'), subjects.changed, { id: '1' })).rejects.toBeInstanceOf(
      ForeignOwnContextError,
    );
    await expect(busA.emit(createBusInstance().own('start'), subjects.changed, { id: '1' })).rejects.toBeInstanceOf(
      ForeignOwnContextError,
    );
  });

  it('rejects the own context of another carrier through scoped and filtered views', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const namespace = registerNamespaceOn(host, 'sendForeignViews');
    const subjects = namespace.subjects;
    const foreign = busB.own('start');

    const scoped = busA.scoped(namespace);
    await expect(scoped.emit(foreign, subjects.changed, { id: '1' })).rejects.toBeInstanceOf(ForeignOwnContextError);
    await expect(scoped.withFilter({ id: '1' }).emit(foreign, subjects.changed, { id: '1' })).rejects.toBeInstanceOf(
      ForeignOwnContextError,
    );
  });

  it('rejects an unminted value on emit, request and broadcast', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendUnminted');
    const forged = { caller: CARRIER_A, principal: PERSON } as CallContext;

    await expect(busA.emit(forged, subjects.changed, { id: '1' })).rejects.toBeInstanceOf(InvalidCallContextError);
    await expect(busA.request(forged, subjects.load, { id: '1' })).rejects.toBeInstanceOf(InvalidCallContextError);
    await expect(busA.broadcast(forged, subjects.announce, { id: '1' })).rejects.toBeInstanceOf(
      InvalidCallContextError,
    );
  });
});

// ---------------------------------------------------------------------------
// Own-context report
// ---------------------------------------------------------------------------

describe('own-context report of sends through an instance', () => {
  it('reports an own context with a reportable purpose sent inside a handler of the same carrier', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendReport');
    host.on(subjects.other, () => undefined);
    busA.on(subjects.changed, async () => {
      await busA.emit(busA.own('start'), subjects.other, { id: 'inner' });
    });

    expect(getOwnCallReport()).toEqual([]);
    await host.emit(host.own('start'), subjects.changed, { id: '1' });

    const report = getOwnCallReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ carrier: CARRIER_A, purpose: 'start', occurrences: 1 });
    expect(report[0].subject).toContain('sendReport');
    expect(report[0].subject).toContain('other');
  });

  it('does not report the handled ctx.call sent on from a handler', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const subjects = registerSubjects(host, 'sendNoReport');
    host.on(subjects.other, () => undefined);
    busA.on(subjects.changed, async (ctx) => {
      await busA.emit(ctx.call, subjects.other, { id: 'inner' });
    });

    await host.emit(host.own('start'), subjects.changed, { id: '1' });

    expect(getOwnCallReport()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Receive path
// ---------------------------------------------------------------------------

describe('receive path', () => {
  it('delivers a received context unchanged and does not derive it', async () => {
    const host = createBusInstance();
    const subjects = registerSubjects(host, 'sendReceivePath');
    const seen: CallContext[] = [];
    host.on(subjects.changed, (ctx) => {
      seen.push(ctx.call);
    });

    await emitReceived(busContextOf(host), passedCall(), subjects.changed, { id: '1' });

    expect(seen).toHaveLength(1);
    expect(seen[0].caller).toEqual(OTHER_CALLER);
    expect(seen[0].principal).toEqual(PERSON);
    expect(seen[0].attestedBy).toEqual(ATTESTER);
  });
});

// ---------------------------------------------------------------------------
// One shared registry for all carrier instances of a host
// ---------------------------------------------------------------------------

describe('carrier instances of one host share one registry', () => {
  it('reaches a handler registered through one carrier by a send through another', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const subjects = registerSubjects(host, 'sendSharedHandler');
    const seen: Party[] = [];
    busA.on(subjects.load, (ctx) => {
      seen.push(ctx.call.caller);
      ctx.setResult({ ok: true });
    });

    const result = await busB.request(passedCall(), subjects.load, { id: '1' });

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([CARRIER_B]);
  });

  it('reaches an interceptor registered through one carrier by a send through another', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const subjects = registerSubjects(host, 'sendSharedInterceptor');
    const intercepted: Party[] = [];
    busA.intercept(subjects.changed, (ctx) => {
      intercepted.push(ctx.call.caller);
      ctx.next();
    });

    await busB.emit(passedCall(), subjects.changed, { id: '1' });

    expect(intercepted).toEqual([CARRIER_B]);
  });

  it('shares a host-registered namespace across carriers', async () => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER_A);
    const busB = createCarrierBus(host, CARRIER_B);
    const subjects = registerSubjects(host, 'sendSharedNamespace');
    const seen: Party[] = [];
    host.on(subjects.changed, (ctx) => {
      seen.push(ctx.call.caller);
    });

    await busB.emit(passedCall(), subjects.changed, { id: '1' });

    expect(seen).toEqual([CARRIER_B]);
    expect(host.getSchema(subjects.changed)).toBe(busA.getSchema(subjects.changed));
    expect(host.getSchema(subjects.changed)).toBe(busB.getSchema(subjects.changed));
    expect(host.getSchema(subjects.changed)).toBeDefined();
  });
});

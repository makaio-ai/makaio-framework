/**
 * Wire path of the call context, end to end.
 *
 * Two (or three) REAL bus instances are joined by the in-process transport
 * pair; nothing of the bus is mocked. The receiving handler's `ctx.call` is
 * what the receive path (`callFromReceive` in `wire.ts`) built
 * from the connection and the message's `metadata`.
 *
 * Covers:
 * - the connection's declared party is the caller; without `metadata` it is also the principal
 * - only attesting connections may send a principal, with direction governing in-process kinds
 * - `claims` never travel, and nothing is read from the payload
 * - event and broadcast relays carry the principal derived on the middle host
 * - an invalid caller is downgraded to anonymous without dropping the event
 * - a connection declaring `makaio.extension` or `makaio.host` is delivered as `makaio.anonymous`,
 *   with exactly one warn-level report per connection and claimed kind
 * - invalid `metadata` is dropped and reported once
 */

import type { CallContext, Party, TransportReceiveContext } from '@makaio/core';
import { createBusNamespace } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import { __resetWireReports } from '../call-context/wire.js';
import { mintCallContext } from '../call-context/mint.js';
import {
  createBusInstance,
  CorrelationTracker,
  handleCorrelationResponse,
  type BusMessage,
  type BusTransport,
} from '../index.js';
import { trackMessageCorrelation } from '../utils/transport-helpers.js';
import { createBidirectionalTransportPair, type BidirectionalTransportSide } from './helpers/transport-fixtures.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WireNamespaceDefinition = createBusNamespace('callContextWire', {
  ping: z.object({ note: z.string() }),
  ask: {
    request: z.object({ question: z.string() }),
    response: z.object({ answer: z.string() }),
  },
});

const { subjects: WireSubjects } = createBusInstance().registerNamespace(WireNamespaceDefinition);

declare module '../index.js' {
  interface BusSubjectsNamespace {
    callContextWire: typeof WireSubjects;
  }
}

const CONNECTION_PARTY: Party = { kind: 'acme.connector', id: 'connection-1' };
const SECOND_CONNECTION_PARTY: Party = { kind: 'acme.connector', id: 'connection-2' };
const JOB_RUN: Party = { kind: 'makaio.job-run', id: 'job-run-1' };
const PERSON: Party = { kind: 'acme.person', id: 'person-1', claims: { role: 'admin' } };
const PERSON_REF = { kind: PERSON.kind, id: PERSON.id };
const LOCAL_CALLER: Party = { kind: 'acme.local', id: 'local-1' };
// Model the unchecked direction a JavaScript transport can supply.
const INHERITED_ATTESTATION: TransportReceiveContext['attests'] = JSON.parse('"toString"');

type WarnSpy = MockInstance<typeof console.warn>;

type TestBus = ReturnType<typeof createBusInstance>;

/** The calls the handlers of a bus saw, in arrival order. */
interface Seen {
  readonly calls: CallContext[];
}

/**
 * Create a bus with the wire namespace registered.
 * @returns The new bus.
 */
function createWireBus(): TestBus {
  const bus = createBusInstance();
  bus.registerNamespace(WireNamespaceDefinition);
  return bus;
}

/**
 * Let a transport side declare the caller of what it receives.
 * @param side - Side of the in-process pair.
 * @param declaredCaller - Party the connection declares.
 * @returns The side with `declaredCaller` set.
 */
function declaring(side: BidirectionalTransportSide, declaredCaller: Party): BusTransport {
  return { ...side, declaredCaller };
}

/**
 * Let a transport side hand a trusted receive context to the bus with every inbound message.
 * The pair's own handler passes none, so the context is added between the side and the bus.
 * @param side - Side of the in-process pair.
 * @param receive - Receive context to attach (`transportName` should be the registered name of the side).
 * @param declaredCaller - Optional party the transport also declares.
 * @returns The wrapped transport.
 */
function withReceiveContext(
  side: BidirectionalTransportSide,
  receive: TransportReceiveContext,
  declaredCaller?: Party,
): BusTransport {
  return {
    ...side,
    ...(declaredCaller === undefined ? {} : { declaredCaller }),
    onReceive: (handler) => side.onReceive(async (message) => handler(message, receive)),
  };
}

/**
 * Record the call of every `ping` event a bus receives.
 * @param bus - Bus to listen on.
 * @returns The record.
 */
function recordPings(bus: TestBus): Seen {
  const seen: Seen = { calls: [] };
  bus.on(WireSubjects.ping, (ctx) => {
    seen.calls.push(ctx.call);
  });
  return seen;
}

/**
 * Wait until a record holds at least `count` calls.
 * @param seen - The record.
 * @param count - Number of calls to wait for.
 */
async function waitForCalls(seen: Seen, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(seen.calls.length).toBeGreaterThanOrEqual(count);
  });
}

/**
 * A call context a sender holds: someone else's work, performed for `principal`.
 * @param principal - Party the work is done for.
 * @returns A minted call context.
 */
function callFor(principal: Party): CallContext {
  return mintCallContext({ caller: LOCAL_CALLER, principal });
}

/**
 * The warn-level reports about the receive path.
 * @param spy - Spy on `console.warn`.
 * @returns The report lines.
 */
function wireReports(spy: WarnSpy): string[] {
  return spy.mock.calls
    .map((args: Parameters<typeof console.warn>) => String(args[0]))
    .filter((line) => line.startsWith('[MakaioBus] '));
}

let warnSpy: WarnSpy;
let buses: TestBus[] = [];

beforeEach(() => {
  __resetWireReports?.();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const bus of buses) bus.disconnect();
  buses = [];
  warnSpy.mockRestore();
  __resetWireReports?.();
});

/**
 * Create a two-bus setup joined by one pair.
 * @param declaredCaller - Party the receiving side declares for its connection.
 * @param attests - Direction of an attesting receiving connection.
 * @param spy - Optional observer of the messages on the wire.
 * @returns Both buses.
 */
function connectedPair(
  declaredCaller: Party,
  attests?: TransportReceiveContext['attests'],
  spy?: (message: BusMessage) => void,
): { sender: TestBus; receiver: TestBus } {
  const { sideA, sideB } = createBidirectionalTransportPair({
    propagateSubscriptions: true,
    ...(spy === undefined ? {} : { spy }),
  });
  const sender = createWireBus();
  const receiver = createWireBus();
  buses.push(sender, receiver);
  sender.registerTransport(sideA);
  receiver.registerTransport(withReceiveContext(sideB, { transportName: sideB.name, attests }, declaredCaller));
  return { sender, receiver };
}

// ---------------------------------------------------------------------------
// Caller, principal, attestation
// ---------------------------------------------------------------------------

describe('call context over the wire', () => {
  it('delivers the connection party as caller and as principal when no metadata travels', async () => {
    const { sender, receiver } = connectedPair(CONNECTION_PARTY);
    const seen = recordPings(receiver);

    // The sender is acting for its own host: nothing to carry.
    const own = sender.own('observer');
    await sender.emit(own, WireSubjects.ping, { note: 'hello' });
    await waitForCalls(seen, 1);

    const [call] = seen.calls;
    expect(call.caller).toEqual(CONNECTION_PARTY);
    expect(call.principal).toEqual(CONNECTION_PARTY);
    expect(call.attestedBy).toBeUndefined();
  });

  it('accepts a principal from an inbound attesting connection', async () => {
    const { sender, receiver } = connectedPair(JOB_RUN, 'inbound');
    const seen = recordPings(receiver);

    await sender.emit(callFor(PERSON), WireSubjects.ping, { note: 'for person' });
    await waitForCalls(seen, 1);

    const [call] = seen.calls;
    expect(call.caller).toEqual(JOB_RUN);
    expect(call.principal).toEqual(PERSON_REF);
    expect(call.attestedBy).toEqual(JOB_RUN);
  });

  it.each([
    { attests: undefined, principal: PERSON, reason: 'unattested-principal' },
    { attests: 'inbound', principal: { kind: 'makaio.extension', id: 'extension-1' }, reason: 'in-process-principal' },
    { attests: 'inbound', principal: { kind: 'makaio.host', id: 'host-1' }, reason: 'in-process-principal' },
  ] as const)('rejects $principal.kind with $reason', async ({ attests, principal, reason }) => {
    const { sender, receiver } = connectedPair(JOB_RUN, attests);
    const seen = recordPings(receiver);

    const call = callFor(principal);
    await sender.emit(call, WireSubjects.ping, { note: 'first claim' });
    await sender.emit(call, WireSubjects.ping, { note: 'second claim' });
    await waitForCalls(seen, 2);

    for (const delivered of seen.calls) {
      expect(delivered.caller).toEqual(JOB_RUN);
      expect(delivered.principal).toEqual(JOB_RUN);
      expect(delivered.attestedBy).toBeUndefined();
    }
    expect(wireReports(warnSpy)).toEqual([expect.stringContaining(reason)]);
  });

  it.each([
    { kind: 'makaio.extension', id: 'extension-1' },
    PERSON_REF,
  ])('rejects $kind when the attestation is an inherited table key', async (principal) => {
    const { sender, receiver } = connectedPair(JOB_RUN, INHERITED_ATTESTATION);
    const seen = recordPings(receiver);

    await sender.emit(callFor(principal), WireSubjects.ping, { note: 'claim' });
    await waitForCalls(seen, 1);

    expect(seen.calls[0].principal).toEqual(JOB_RUN);
    expect(seen.calls[0].attestedBy).toBeUndefined();
    expect(wireReports(warnSpy)).toEqual([expect.stringContaining('unattested-principal')]);
  });

  it('accepts an in-process principal from an outbound attesting connection', async () => {
    const { sender, receiver } = connectedPair(CONNECTION_PARTY, 'outbound');
    const seen = recordPings(receiver);
    const principal = { kind: 'makaio.extension', id: 'extension-1' };

    await sender.emit(callFor(principal), WireSubjects.ping, { note: 'outbound' });
    await waitForCalls(seen, 1);

    expect(seen.calls[0].principal).toEqual(principal);
    expect(seen.calls[0].attestedBy).toEqual(CONNECTION_PARTY);
  });

  it('never lets claims travel', async () => {
    const messages: BusMessage[] = [];
    const { sender, receiver } = connectedPair(CONNECTION_PARTY, 'inbound', (message) => messages.push(message));
    const seen = recordPings(receiver);

    await sender.emit(callFor(PERSON), WireSubjects.ping, { note: 'claims' });
    await waitForCalls(seen, 1);

    const events = messages.filter((message) => message.type === 'event');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({ principal: { kind: PERSON.kind, id: PERSON.id } });
    expect(JSON.stringify(events[0])).not.toContain('admin');
    expect(seen.calls[0].principal.claims).toBeUndefined();
  });

  it('reads nothing from the payload', async () => {
    const { sender, receiver } = connectedPair(CONNECTION_PARTY);
    const seen = recordPings(receiver);

    const forged = { note: 'forged', caller: PERSON, principal: PERSON, call: callFor(PERSON) };
    await sender.emit(sender.own('observer'), WireSubjects.ping, forged);
    await waitForCalls(seen, 1);

    expect(seen.calls[0].caller).toEqual(CONNECTION_PARTY);
    expect(seen.calls[0].principal).toEqual(CONNECTION_PARTY);
  });

  it('prefers the caller of the receive context over the declared one', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({ propagateSubscriptions: true });
    const sender = createWireBus();
    const receiver = createWireBus();
    buses.push(sender, receiver);
    sender.registerTransport(sideA);
    receiver.registerTransport(
      withReceiveContext(
        sideB,
        { transportName: sideB.name, connectionId: 'session-7', caller: SECOND_CONNECTION_PARTY },
        CONNECTION_PARTY,
      ),
    );
    const seen = recordPings(receiver);

    await sender.emit(sender.own('observer'), WireSubjects.ping, { note: 'receive caller' });
    await waitForCalls(seen, 1);

    expect(seen.calls[0].caller).toEqual(SECOND_CONNECTION_PARTY);
    expect(seen.calls[0].principal).toEqual(SECOND_CONNECTION_PARTY);
  });

  it('names the connection id in the anonymous caller and in the report', async () => {
    const { sideA, sideB } = createBidirectionalTransportPair({ propagateSubscriptions: true });
    const sender = createWireBus();
    const receiver = createWireBus();
    buses.push(sender, receiver);
    sender.registerTransport(sideA);
    receiver.registerTransport(
      withReceiveContext(sideB, {
        transportName: sideB.name,
        connectionId: 'session-9',
        caller: { kind: 'makaio.host', id: 'claimed' },
      }),
    );
    const seen = recordPings(receiver);

    await sender.emit(sender.own('observer'), WireSubjects.ping, { note: 'anonymous id' });
    await waitForCalls(seen, 1);

    expect(seen.calls[0].caller).toEqual({ kind: 'makaio.anonymous', id: 'session-9' });
    const reports = wireReports(warnSpy).filter((line) => line.includes("'makaio.host'"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('connection=session-9');
  });

  it('gives a request handler the same context', async () => {
    const { sender, receiver } = connectedPair(CONNECTION_PARTY, 'inbound');
    let seenCall: CallContext | undefined;
    receiver.on(WireSubjects.ask, (ctx) => {
      seenCall = ctx.call;
      ctx.setResult({ answer: 'yes' });
    });

    // Handler registration propagates over the pair asynchronously.
    await vi.waitFor(async () => {
      const result = await sender.request(callFor(PERSON), WireSubjects.ask, { question: 'q' }, { timeout: 500 });
      expect(result.answer).toBe('yes');
    });

    expect(seenCall?.caller).toEqual(CONNECTION_PARTY);
    expect(seenCall?.principal).toMatchObject({ kind: PERSON.kind, id: PERSON.id });
    expect(seenCall?.attestedBy).toEqual(CONNECTION_PARTY);
  });
});

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * Extend the in-process pair's request correlation to broadcasts sent from side A.
 * @param label - Prefix for the transport names.
 * @param sent - Messages captured in the forward direction.
 * @returns A pair that returns the downstream bus's broadcast results.
 */
function relayPair(label: string, sent: BusMessage[]) {
  const broadcasts = new CorrelationTracker();
  const { sideA, sideB } = createBidirectionalTransportPair({
    label,
    propagateSubscriptions: true,
    spy: (message, direction) => {
      if (direction === 'a-to-b') sent.push(message);
      if (direction === 'b-to-a' && message.type === 'broadcast-response') {
        handleCorrelationResponse(message, broadcasts);
      }
    },
  });
  const send: BusTransport['send'] = (message, timeout) => {
    if (message.type !== 'broadcast') return sideA.send(message, timeout);
    const results = trackMessageCorrelation(message, broadcasts, timeout ?? 500);
    void sideA.send(message, timeout);
    return results;
  };
  return { sideA: { ...sideA, send }, sideB };
}

/**
 * Join three real buses and observe the application messages on each hop.
 * @param caller - Party declared on the middle host's incoming transport.
 * @returns The buses and the captured messages.
 */
function connectedRelay(caller?: Party) {
  const incoming: BusMessage[] = [];
  const relayed: BusMessage[] = [];
  const first = relayPair('first', incoming);
  const second = relayPair('second', relayed);
  const origin = createWireBus();
  const middle = createWireBus();
  const far = createWireBus();
  buses.push(origin, middle, far);

  origin.registerTransport(first.sideA);
  middle.registerTransport(
    caller === undefined
      ? first.sideB
      : withReceiveContext(first.sideB, { transportName: first.sideB.name, attests: 'inbound' }, caller),
  );
  middle.registerTransport(second.sideA);
  far.registerTransport(
    withReceiveContext(second.sideB, { transportName: second.sideB.name, attests: 'inbound' }, SECOND_CONNECTION_PARTY),
  );
  return { origin, middle, far, incoming, relayed };
}

describe('relayed messages', () => {
  it('carries the original peer as principal when an event has no metadata', async () => {
    const { origin, middle, far, incoming } = connectedRelay(CONNECTION_PARTY);
    const seenMiddle = recordPings(middle);
    const seenFar = recordPings(far);

    await origin.emit(origin.own('observer'), WireSubjects.ping, { note: 'relay' });
    await waitForCalls(seenMiddle, 1);
    await waitForCalls(seenFar, 1);

    expect(incoming.find((message) => message.type === 'event')).not.toHaveProperty('metadata');
    expect(seenMiddle.calls[0].principal).toEqual(CONNECTION_PARTY);
    expect(seenFar.calls[0].principal).toEqual(CONNECTION_PARTY);
    expect(seenFar.calls[0].attestedBy).toEqual(SECOND_CONNECTION_PARTY);
  });

  it('carries the original peer as principal when a broadcast has no metadata', async () => {
    const { origin, middle, far, incoming } = connectedRelay(CONNECTION_PARTY);
    const seen: CallContext[] = [];
    for (const [bus, answer] of [
      [middle, 'middle'],
      [far, 'far'],
    ] as const) {
      bus.on(WireSubjects.ask, (ctx) => {
        seen.push(ctx.call);
        ctx.setResult({ answer });
      });
    }

    const results = await origin.broadcast(
      origin.own('observer'),
      WireSubjects.ask,
      { question: 'q' },
      { timeout: 500 },
    );
    expect(results.map(({ payload }) => payload.answer).sort()).toEqual(['far', 'middle']);
    expect(incoming.find((message) => message.type === 'broadcast')).not.toHaveProperty('metadata');
    expect(seen).toHaveLength(2);
    expect(seen.find(({ caller }) => caller.id === CONNECTION_PARTY.id)?.principal).toEqual(CONNECTION_PARTY);
    const farCall = seen.find(({ caller }) => caller.id === SECOND_CONNECTION_PARTY.id);
    expect(farCall?.principal).toEqual(CONNECTION_PARTY);
    expect(farCall?.attestedBy).toEqual(SECOND_CONNECTION_PARTY);
  });

  it('restamps an unattested broadcast so a forged principal does not reach the next hop', async () => {
    const { origin, middle, far, relayed } = connectedRelay();
    const anonymous = { kind: 'makaio.anonymous', id: 'first-side-b' };
    const seen: CallContext[] = [];
    for (const [bus, answer] of [
      [middle, 'middle'],
      [far, 'far'],
    ] as const) {
      bus.on(WireSubjects.ask, (ctx) => {
        seen.push(ctx.call);
        ctx.setResult({ answer });
      });
    }

    await origin.broadcast(callFor(PERSON), WireSubjects.ask, { question: 'q' }, { timeout: 500 });

    const relayedBroadcast = relayed.find((message) => message.type === 'broadcast');
    expect(relayedBroadcast?.metadata).toEqual({ principal: anonymous });
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.principal).toEqual(anonymous);
  });

  it.each([
    { name: 'declared', declared: CONNECTION_PARTY, caller: CONNECTION_PARTY },
    { name: 'anonymous', declared: undefined, caller: { kind: 'makaio.anonymous', id: 'first-side-b' } },
  ])('rebuilds principal metadata from a $name peer for the next hop', async ({ declared, caller }) => {
    const { origin, middle, far, incoming, relayed } = connectedRelay(declared);
    const seenMiddle = recordPings(middle);
    const seenFar = recordPings(far);

    await origin.emit(callFor(PERSON), WireSubjects.ping, { note: 'relay' });
    await waitForCalls(seenMiddle, 1);
    await waitForCalls(seenFar, 1);

    const receivedEvent = incoming.find((message) => message.type === 'event');
    const relayedEvents = relayed.filter((message) => message.type === 'event');
    expect(relayedEvents).toHaveLength(1);
    expect(relayedEvents[0]).not.toBe(receivedEvent);
    expect(relayedEvents[0].metadata).not.toBe(receivedEvent?.metadata);
    expect(relayedEvents[0].metadata).toEqual({ principal: seenMiddle.calls[0].principal });

    expect(seenMiddle.calls[0].caller).toEqual(caller);
    const expectedPrincipal = declared === undefined ? caller : PERSON_REF;
    expect(seenMiddle.calls[0].attestedBy).toEqual(declared);
    expect(seenMiddle.calls[0].principal).toEqual(expectedPrincipal);
    expect(seenFar.calls[0].caller).toEqual(SECOND_CONNECTION_PARTY);
    expect(seenFar.calls[0].principal).toEqual(expectedPrincipal);
    expect(seenFar.calls[0].attestedBy).toEqual(SECOND_CONNECTION_PARTY);
  });

  it('downgrades an invalid caller and still delivers and relays both events', async () => {
    const { origin, middle, far } = connectedRelay({ kind: CONNECTION_PARTY.kind, id: '' });
    const seenMiddle = recordPings(middle);
    const seenFar = recordPings(far);

    for (const note of ['one', 'two']) {
      await origin.emit(origin.own('observer'), WireSubjects.ping, { note });
    }
    await waitForCalls(seenMiddle, 2);
    await waitForCalls(seenFar, 2);

    const anonymous = { kind: 'makaio.anonymous', id: 'first-side-b' };
    for (const call of seenMiddle.calls) {
      expect(call.caller).toEqual(anonymous);
      expect(call.principal).toEqual(anonymous);
      expect(call.attestedBy).toBeUndefined();
    }
    for (const call of seenFar.calls) {
      expect(call.principal).toEqual(anonymous);
      expect(call.attestedBy).toEqual(SECOND_CONNECTION_PARTY);
    }
    expect(wireReports(warnSpy)).toEqual([expect.stringContaining('invalid caller')]);
  });
});

// ---------------------------------------------------------------------------
// In-process-only kinds (downgrade and report)
// ---------------------------------------------------------------------------

describe.each(['makaio.extension', 'makaio.host'])('a connection declaring kind %s', (kind) => {
  const CLAIMED: Party = { kind, id: 'claimed-1' };

  it('is delivered as makaio.anonymous with exactly one warn-level report', async () => {
    const { sender, receiver } = connectedPair(CLAIMED);
    const seen = recordPings(receiver);

    await sender.emit(sender.own('observer'), WireSubjects.ping, { note: 'one' });
    await sender.emit(sender.own('observer'), WireSubjects.ping, { note: 'two' });
    await sender.emit(sender.own('observer'), WireSubjects.ping, { note: 'three' });
    await waitForCalls(seen, 3);

    for (const call of seen.calls) {
      expect(call.caller.kind).toBe('makaio.anonymous');
      expect(call.principal.kind).toBe('makaio.anonymous');
    }

    const reports = wireReports(warnSpy).filter((line) => line.includes(`'${kind}'`));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('transport=in-process-side-b');
  });

  it('drops an accepted principal claim together with the downgraded caller', async () => {
    const { sender, receiver } = connectedPair(CLAIMED, 'inbound');
    const seen = recordPings(receiver);

    await sender.emit(callFor(PERSON), WireSubjects.ping, { note: 'claim behind a downgraded caller' });
    await waitForCalls(seen, 1);

    expect(seen.calls[0].caller.kind).toBe('makaio.anonymous');
    expect(seen.calls[0].principal).toEqual(seen.calls[0].caller);
    expect(seen.calls[0].attestedBy).toBeUndefined();
  });

  it('reports again for another connection', async () => {
    const first = connectedPair(CLAIMED);
    const second = createBidirectionalTransportPair({ label: 'other', propagateSubscriptions: true });
    const otherSender = createWireBus();
    const otherReceiver = createWireBus();
    buses.push(otherSender, otherReceiver);
    otherSender.registerTransport(second.sideA);
    otherReceiver.registerTransport(declaring(second.sideB, CLAIMED));
    const seenFirst = recordPings(first.receiver);
    const seenOther = recordPings(otherReceiver);

    await first.sender.emit(first.sender.own('observer'), WireSubjects.ping, { note: 'a' });
    await otherSender.emit(otherSender.own('observer'), WireSubjects.ping, { note: 'b' });
    await waitForCalls(seenFirst, 1);
    await waitForCalls(seenOther, 1);

    expect(wireReports(warnSpy).filter((line) => line.includes(`'${kind}'`))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Invalid metadata
// ---------------------------------------------------------------------------

describe('invalid metadata', () => {
  it('is dropped and reported once per connection', async () => {
    // A peer on the wire sends garbage metadata: raw sends into the receiving side.
    const { sideA: rawA, sideB: rawB } = createBidirectionalTransportPair({ label: 'garbage' });
    const garbageReceiver = createWireBus();
    buses.push(garbageReceiver);
    garbageReceiver.registerTransport(declaring(rawB, CONNECTION_PARTY));
    const seenGarbage = recordPings(garbageReceiver);

    for (const note of ['first', 'second']) {
      // Round-tripped through JSON like real wire bytes, so the invalid shape needs no cast.
      const message: BusMessage = JSON.parse(
        JSON.stringify({
          type: 'event',
          namespace: 'callContextWire',
          subject: 'ping',
          payload: { note },
          messageId: `garbage-${note}`,
          metadata: { principal: { kind: 42 } },
        }),
      );
      await rawA.send(message);
    }
    await waitForCalls(seenGarbage, 2);

    for (const call of seenGarbage.calls) {
      expect(call.caller).toEqual(CONNECTION_PARTY);
      expect(call.principal).toEqual(CONNECTION_PARTY);
      expect(call.attestedBy).toBeUndefined();
    }
    const reports = wireReports(warnSpy).filter((line) => line.includes('invalid wire metadata'));
    expect(reports).toHaveLength(1);
  });
});

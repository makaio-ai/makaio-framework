/**
 * Both send forms on every bus surface.
 *
 * `emit`, `request` and `requestOptional` of the main bus, a scoped bus, a filtered bus and
 * `Namespace.scopedBus(bus)` take either a minted call context first (call form) or the subject
 * first (own form). A first argument that is neither is rejected before anything is sent.
 * Real buses, real handlers, no mocks. The sends go through the member of the surface itself;
 * the arguments are passed as plain values, so the runtime resolution is what is under test
 * (the compile-time forms are pinned by the type fixtures).
 */

import { createBusNamespace, type CallContext, type Party, type PartyRef } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '../bus.js';
import { createCarrierBus } from '../bus-instance.js';
import { InvalidCallContextError, mintCallContext } from '../call-context/mint.js';
import { __resetOwnWork, getOwnCallReport } from '../call-context/own-work.js';
import { busContextOf } from '../kernel-api.js';
import { MockTransport } from './helpers/transport-fixtures.js';

declare module '../index.js' {
  interface BusTransportRegistry {
    'send-optional-transport': MockTransport;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'MAKAIO_OWN_CALL_REPORT';
const CARRIER: PartyRef = { kind: 'makaio.extension', id: 'send-optional-carrier' };
const PERSON: Party = { kind: 'acme.person', id: 'person-1' };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };
const OTHER_CALLER: Party = { kind: 'acme.other', id: 'other-1' };
const PAYLOAD = { id: '1' };

type Operation = 'emit' | 'request' | 'requestOptional';
const OPERATIONS: readonly Operation[] = ['emit', 'request', 'requestOptional'];

let namespaceCounter = 0;

/**
 * Mint a received-style context: another principal, attested by a gateway, caller is neither carrier.
 * @returns The minted context.
 */
function passedCall(): CallContext {
  return mintCallContext({ caller: OTHER_CALLER, principal: PERSON, attestedBy: ATTESTER });
}

/** What a handler observed about one delivered message. */
interface Seen {
  readonly call: CallContext;
  readonly correlationId: string | undefined;
}

/**
 * Register a fresh namespace pair on a host.
 * @param host - Host bus instance.
 * @returns The scoped namespace, its subjects and the subjects of a second namespace.
 */
function registerNamespaces(host: ReturnType<typeof createBusInstance>) {
  namespaceCounter += 1;
  const main = host.registerNamespace(
    createBusNamespace(`sendOptional${namespaceCounter}`, {
      changed: z.object({ id: z.string() }),
      load: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
      trigger: z.object({ id: z.string() }),
    }),
  );
  const other = host.registerNamespace(
    createBusNamespace(`sendOptionalOther${namespaceCounter}`, {
      ping: z.object({ id: z.string() }),
      pong: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
    }),
  );
  return { namespace: main, subjects: main.subjects, otherSubjects: other.subjects };
}

type Fixtures = ReturnType<typeof registerNamespaces>;

/**
 * Send through a member of a surface with plain arguments.
 * @param target - Bus surface.
 * @param operation - Member to call.
 * @param args - Arguments of the send, in either form.
 * @returns Whatever the member returns.
 */
function send(target: object, operation: Operation, ...args: readonly unknown[]): Promise<unknown> {
  return Reflect.apply(Reflect.get(target, operation), target, args);
}

interface SurfaceCase {
  readonly label: string;
  readonly scoped: boolean;
  readonly build: (busA: ReturnType<typeof createCarrierBus>, fixtures: Fixtures) => Promise<object>;
}

const SURFACES: readonly SurfaceCase[] = [
  { label: 'main bus', scoped: false, build: (busA) => Promise.resolve(busA) },
  { label: 'scoped bus', scoped: true, build: (busA, f) => Promise.resolve(busA.scoped(f.namespace)) },
  {
    label: 'filtered bus',
    scoped: true,
    build: (busA, f) => Promise.resolve(busA.scoped(f.namespace).withFilter({ id: '1' })),
  },
  {
    label: 'Namespace.scopedBus(bus)',
    scoped: true,
    build: (busA, f) => f.namespace.scopedBus(busA),
  },
];

beforeEach(() => {
  delete process.env[ENV_KEY];
  __resetOwnWork?.();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  __resetOwnWork?.();
});

describe.each(SURFACES)('send forms on the $label', ({ scoped, build }) => {
  let host: ReturnType<typeof createBusInstance>;
  let busA: ReturnType<typeof createCarrierBus>;
  let fixtures: Fixtures;
  let target: object;
  let seen: Seen[];
  let forwardable: CallContext | undefined;

  /**
   * Subject of an operation: an event for `emit`, the request subject otherwise.
   * @param operation - Operation under test.
   * @returns The subject to send.
   */
  function subjectOf(operation: Operation) {
    return operation === 'emit' ? fixtures.subjects.changed : fixtures.subjects.load;
  }

  beforeEach(async () => {
    host = createBusInstance();
    busA = createCarrierBus(host, CARRIER);
    fixtures = registerNamespaces(host);
    target = await build(busA, fixtures);
    seen = [];
    forwardable = undefined;
    host.on(fixtures.subjects.changed, (ctx) => {
      seen.push({ call: ctx.call, correlationId: ctx.correlationId });
    });
    host.on(fixtures.subjects.load, (ctx) => {
      seen.push({ call: ctx.call, correlationId: ctx.correlationId });
      ctx.setResult({ ok: true });
    });
    // A handled message whose ctx.call a handler forwards in call form.
    host.on(fixtures.subjects.trigger, (ctx) => {
      forwardable = ctx.call;
    });
    await host.emit(passedCall(), fixtures.subjects.trigger, PAYLOAD);
  });

  describe.each(OPERATIONS)('%s', (operation) => {
    it('own form: the handler sees the carrier as caller and principal', async () => {
      await send(target, operation, subjectOf(operation), PAYLOAD);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.call.caller).toEqual(CARRIER);
      expect(seen[0]?.call.principal).toEqual(CARRIER);
      expect(seen[0]?.call.attestedBy).toBeUndefined();
    });

    it("call form with a handler's ctx.call: principal and attestation are kept, the caller is the carrier", async () => {
      expect(forwardable).toBeDefined();
      await send(target, operation, forwardable, subjectOf(operation), PAYLOAD);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.call.caller).toEqual(CARRIER);
      expect(seen[0]?.call.principal).toEqual(PERSON);
      expect(seen[0]?.call.attestedBy).toEqual(ATTESTER);
    });

    it('passes options through in both forms', async () => {
      await send(target, operation, subjectOf(operation), PAYLOAD, { correlationId: 'corr-own' });
      await send(target, operation, passedCall(), subjectOf(operation), PAYLOAD, { correlationId: 'corr-call' });

      expect(seen.map((entry) => entry.correlationId)).toEqual(['corr-own', 'corr-call']);
    });

    it('rejects an unminted literal first with InvalidCallContextError and delivers nothing', async () => {
      const literal = { caller: PERSON, principal: PERSON };

      await expect(send(target, operation, literal, subjectOf(operation), PAYLOAD)).rejects.toThrow(
        InvalidCallContextError,
      );
      expect(seen).toHaveLength(0);
    });

    it('rejects a fake context that only has a $meta key with InvalidCallContextError and delivers nothing', async () => {
      const fake = { caller: PERSON, principal: PERSON, $meta: {} };

      await expect(send(target, operation, fake, subjectOf(operation), PAYLOAD)).rejects.toThrow(
        InvalidCallContextError,
      );
      expect(seen).toHaveLength(0);
    });

    it('rejects a call form without a subject and delivers nothing', async () => {
      await expect(send(target, operation, passedCall(), PAYLOAD)).rejects.toThrow();
      expect(seen).toHaveLength(0);
    });

    it.runIf(scoped)('rejects a subject of another namespace in own form', async () => {
      await expect(send(target, operation, fixtures.otherSubjects.ping, PAYLOAD)).rejects.toThrow();
      expect(seen).toHaveLength(0);
    });

    describe.runIf(scoped)('a subject whose namespace changes while it is read', () => {
      const otherDelivered: string[] = [];

      /**
       * Subject of the other namespace for the operation, with its handler registered on the host.
       * @returns The real subject of the other namespace.
       */
      function watchedOtherSubject() {
        otherDelivered.length = 0;
        host.on(fixtures.otherSubjects.ping, () => {
          otherDelivered.push('ping');
        });
        host.on(fixtures.otherSubjects.pong, (ctx) => {
          otherDelivered.push('pong');
          ctx.setResult({ ok: true });
        });
        return operation === 'emit' ? fixtures.otherSubjects.ping : fixtures.otherSubjects.pong;
      }

      /**
       * Build a fresh subject of the other namespace whose enumerable `$meta.namespace` getter
       * answers through `answers`, one answer per read. The k-th read gets the k-th answer; every
       * later read gets the other namespace. Each call returns an independent subject.
       * @param real - Real subject of the other namespace.
       * @param answers - Answer per read (`undefined` makes that read throw).
       * @returns The subject-shaped object.
       */
      function flippingSubject(real: ReturnType<typeof watchedOtherSubject>, answers: readonly (string | undefined)[]) {
        let reads = 0;
        return {
          subject: real.subject,
          $meta: {
            ...real.$meta,
            get namespace(): string {
              const answer = reads < answers.length ? answers[reads] : real.$meta.namespace;
              reads += 1;
              if (answer === undefined) {
                throw new Error('namespace is not readable');
              }
              return answer;
            },
          },
        };
      }

      it('never delivers to the other namespace after it answered the scope on its first read (own and call form)', async () => {
        const real = watchedOtherSubject();
        const scopeNamespace = fixtures.subjects.changed.$meta.namespace;

        // Either outcome (rejected, or delivered inside the checked namespace) is acceptable.
        await send(target, operation, flippingSubject(real, [scopeNamespace]), PAYLOAD).catch(() => undefined);
        await send(target, operation, passedCall(), flippingSubject(real, [scopeNamespace]), PAYLOAD).catch(
          () => undefined,
        );

        expect(otherDelivered).toEqual([]);
      });

      it('rejects in call form a subject whose namespace getter throws first, then answers the scope, then the other namespace', async () => {
        const real = watchedOtherSubject();
        const scopeNamespace = fixtures.subjects.changed.$meta.namespace;
        const method = operation === 'emit' ? 'emit' : 'request';

        await expect(
          send(target, operation, passedCall(), flippingSubject(real, [undefined, scopeNamespace]), PAYLOAD),
        ).rejects.toThrow(`Invalid subject definition provided to ${method}()`);

        expect(otherDelivered).toEqual([]);
        expect(seen).toHaveLength(0);
      });
    });
  });

  describe('own-context report', () => {
    /**
     * Register a handler of the carrier that sends through the surface while its call is open.
     * @param operation - Operation the handler sends with.
     * @param first - Leading arguments of the send (empty for own form, `[call]` for call form).
     * @returns Resolves when the handler's own send is done and the trigger returned.
     */
    async function runHandler(
      operation: Operation,
      first: (ctx: { readonly call: CallContext }) => readonly unknown[],
    ): Promise<void> {
      busA.on(fixtures.subjects.trigger, async (ctx) => {
        await send(target, operation, ...first(ctx), subjectOf(operation), PAYLOAD);
      });
      await host.emit(host.own('root'), fixtures.subjects.trigger, PAYLOAD);
    }

    it.each(OPERATIONS)('%s in own form inside an open handler call is reported once without purpose', async (op) => {
      await runHandler(op, () => []);

      const report = getOwnCallReport();
      expect(report).toHaveLength(1);
      expect(report[0]).toMatchObject({ carrier: CARRIER, purpose: undefined, occurrences: 1 });
      expect(report[0]?.subject).toContain(op === 'emit' ? 'changed' : 'load');
    });

    it.each(OPERATIONS)("%s with the handler's ctx.call is not reported", async (op) => {
      await runHandler(op, (ctx) => [ctx.call]);

      expect(getOwnCallReport()).toEqual([]);
    });

    it.each(OPERATIONS)("%s with own('shared-work') is not reported", async (op) => {
      await runHandler(op, () => [busA.own('shared-work')]);

      expect(getOwnCallReport()).toEqual([]);
    });

    it('does not report an own-form send outside a handler call', async () => {
      await send(target, 'emit', fixtures.subjects.changed, PAYLOAD);

      expect(getOwnCallReport()).toEqual([]);
    });
  });
});

describe('broadcast on the main bus', () => {
  let host: ReturnType<typeof createBusInstance>;
  let busA: ReturnType<typeof createCarrierBus>;
  let fixtures: Fixtures;
  let seen: Seen[];

  beforeEach(() => {
    host = createBusInstance();
    busA = createCarrierBus(host, CARRIER);
    fixtures = registerNamespaces(host);
    seen = [];
    host.on(fixtures.subjects.load, (ctx) => {
      seen.push({ call: ctx.call, correlationId: ctx.correlationId });
      ctx.setResult({ ok: true });
    });
  });

  /**
   * Broadcast with plain arguments through the main bus.
   * @param args - Arguments of the broadcast, in either form.
   * @returns Whatever the bus returns.
   */
  function broadcast(...args: readonly unknown[]): Promise<unknown> {
    return Reflect.apply(Reflect.get(busA, 'broadcast'), busA, args);
  }

  it('own form: the handler sees the carrier as caller and principal', async () => {
    await broadcast(fixtures.subjects.load, PAYLOAD);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.call.caller).toEqual(CARRIER);
    expect(seen[0]?.call.principal).toEqual(CARRIER);
    expect(seen[0]?.call.attestedBy).toBeUndefined();
  });

  it('call form: principal and attestation are kept, the caller is the carrier', async () => {
    await broadcast(passedCall(), fixtures.subjects.load, PAYLOAD);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.call.caller).toEqual(CARRIER);
    expect(seen[0]?.call.principal).toEqual(PERSON);
    expect(seen[0]?.call.attestedBy).toEqual(ATTESTER);
  });

  it('passes options through in both forms', async () => {
    await broadcast(fixtures.subjects.load, PAYLOAD, { correlationId: 'corr-own' });
    await broadcast(passedCall(), fixtures.subjects.load, PAYLOAD, { correlationId: 'corr-call' });

    expect(seen.map((entry) => entry.correlationId)).toEqual(['corr-own', 'corr-call']);
  });

  it('rejects an unminted literal first with InvalidCallContextError and delivers nothing', async () => {
    const literal = { caller: PERSON, principal: PERSON };

    await expect(broadcast(literal, fixtures.subjects.load, PAYLOAD)).rejects.toThrow(InvalidCallContextError);
    expect(seen).toHaveLength(0);
  });

  it('rejects a fake context that only has a $meta key with InvalidCallContextError and delivers nothing', async () => {
    const fake = { caller: PERSON, principal: PERSON, $meta: {} };

    await expect(broadcast(fake, fixtures.subjects.load, PAYLOAD)).rejects.toThrow(InvalidCallContextError);
    expect(seen).toHaveLength(0);
  });

  it('reports an own-form broadcast inside an open handler call once without purpose', async () => {
    busA.on(fixtures.subjects.trigger, async () => {
      await broadcast(fixtures.subjects.load, PAYLOAD);
    });
    await host.emit(host.own('root'), fixtures.subjects.trigger, PAYLOAD);

    const report = getOwnCallReport();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ carrier: CARRIER, purpose: undefined, occurrences: 1 });
    expect(report[0]?.subject).toContain('load');
  });
});

describe('transport options on every surface', () => {
  it.each(SURFACES)('emit keeps the message local with transports: [] on the $label', async ({ build }) => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER);
    const fixtures = registerNamespaces(host);
    const transport = new MockTransport('send-optional-transport');
    busContextOf(host).transportRegistry.registerTransport('send-optional-transport', transport);
    const target = await build(busA, fixtures);
    const events = () => transport.messages.filter((message) => message.type === 'event');

    await send(target, 'emit', fixtures.subjects.changed, PAYLOAD, { transports: [] });
    await send(target, 'emit', passedCall(), fixtures.subjects.changed, PAYLOAD, { transports: [] });
    expect(events()).toHaveLength(0);

    await send(target, 'emit', fixtures.subjects.changed, PAYLOAD, { transports: ['send-optional-transport'] });
    expect(events()).toHaveLength(1);
    await send(target, 'emit', passedCall(), fixtures.subjects.changed, PAYLOAD, {
      transports: ['send-optional-transport'],
    });
    expect(events()).toHaveLength(2);
  });
});

describe('requestOptional without a handler', () => {
  it.each(SURFACES)('gives handled: false in both forms on the $label', async ({ build }) => {
    const host = createBusInstance();
    const busA = createCarrierBus(host, CARRIER);
    const fixtures = registerNamespaces(host);
    const target = await build(busA, fixtures);

    expect(await send(target, 'requestOptional', fixtures.subjects.load, PAYLOAD)).toEqual({ handled: false });
    expect(await send(target, 'requestOptional', passedCall(), fixtures.subjects.load, PAYLOAD)).toEqual({
      handled: false,
    });
  });
});

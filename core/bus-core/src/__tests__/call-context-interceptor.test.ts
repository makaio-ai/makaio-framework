import { createBusNamespace } from '@makaio/core';
import type { CallContext, Party, PartyRef } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '../bus.js';
import { createCarrierBus } from '../bus-instance.js';
import { ForeignOwnContextError } from '../call-context/carrier.js';
import { isMintedCallContext, mintCallContext } from '../call-context/mint.js';
import { __resetOwnWork, getOwnCallReport, openHandlerCallCount } from '../call-context/own-work.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'MAKAIO_OWN_CALL_REPORT';

const SENDER: PartyRef = { kind: 'makaio.extension', id: 'interceptor-test-sender' };
const WATCHER: PartyRef = { kind: 'makaio.extension', id: 'interceptor-test-watcher' };

const PERSON: Party = { kind: 'acme.person', id: 'person-1', claims: { role: 'admin' } };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };

const Namespace = createBusNamespace('callContextInterceptorTest', {
  first: z.object({ value: z.string() }),
  second: z.object({ value: z.string() }),
  third: z.object({ value: z.string() }),
});

/**
 * Build a real bus context with two carrier instances sharing it.
 * @returns The host instance, a sender instance, a watcher instance and the registered subjects.
 */
function createRig() {
  const host = createBusInstance();
  const { subjects } = host.registerNamespace(Namespace);
  return {
    host,
    sender: createCarrierBus(host, SENDER),
    watcher: createCarrierBus(host, WATCHER),
    subjects,
  };
}

/**
 * Mint the context of a message sent on behalf of a person through a gateway.
 * @returns The minted context.
 */
function personCall(): CallContext {
  return mintCallContext({ caller: { kind: 'acme.remote', id: 'remote-1' }, principal: PERSON, attestedBy: ATTESTER });
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
// ctx.call of an interceptor
// ---------------------------------------------------------------------------

describe('InterceptorContext.call', () => {
  it('is the sent context: caller is the sending carrier, principal and attestedBy are kept', async () => {
    const { sender, watcher, subjects } = createRig();
    const seen: CallContext[] = [];
    watcher.intercept(subjects.first, (ctx) => {
      seen.push(ctx.call);
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(isMintedCallContext(call)).toBe(true);
    expect(call.caller).toEqual(SENDER);
    expect(call.principal).toEqual(PERSON);
    expect(call.attestedBy).toEqual(ATTESTER);
  });

  it('shows the sender and not the intercepting carrier as caller', async () => {
    const { sender, watcher, subjects } = createRig();
    let caller: Party | undefined;
    watcher.intercept(subjects.first, (ctx) => {
      caller = ctx.call.caller;
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(caller).toEqual(SENDER);
    expect(caller).not.toEqual(WATCHER);
  });

  it('is the same context for every interceptor of the chain and for the handler', async () => {
    const { sender, watcher, host, subjects } = createRig();
    const seen: CallContext[] = [];
    watcher.intercept(subjects.first, (ctx) => void seen.push(ctx.call), { priority: 10 });
    host.intercept(subjects.first, (ctx) => void seen.push(ctx.call), { priority: 5 });
    watcher.on(subjects.first, (ctx) => {
      seen.push(ctx.call);
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  it('for the own context of the sender: principal equals caller', async () => {
    const { sender, watcher, subjects } = createRig();
    let call: CallContext | undefined;
    watcher.intercept(subjects.first, (ctx) => {
      call = ctx.call;
    });

    await sender.emit(sender.own('root'), subjects.first, { value: 'a' });

    expect(call?.caller).toEqual(SENDER);
    expect(call?.principal).toEqual(SENDER);
  });
});

// ---------------------------------------------------------------------------
// Owner of the interceptor
// ---------------------------------------------------------------------------

describe('interceptor owner', () => {
  it('counts the interceptor call as an open handler call of the registering carrier, not of the sender', async () => {
    const { sender, watcher, subjects } = createRig();
    const open: Array<{ watcher: number; sender: number }> = [];
    watcher.intercept(subjects.first, () => {
      open.push({ watcher: openHandlerCallCount(WATCHER), sender: openHandlerCallCount(SENDER) });
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(open).toEqual([{ watcher: 1, sender: 0 }]);
    expect(openHandlerCallCount(WATCHER)).toBe(0);
  });

  it('keeps the count raised until an asynchronous interceptor has settled', async () => {
    const { sender, watcher, subjects } = createRig();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    watcher.intercept(subjects.first, async () => {
      await gate;
    });

    const pending = sender.emit(personCall(), subjects.first, { value: 'a' });
    expect(openHandlerCallCount(WATCHER)).toBe(1);
    release();
    await pending;
    expect(openHandlerCallCount(WATCHER)).toBe(0);
  });

  it('reports an own context the interceptor sends with while its call is open', async () => {
    const { sender, watcher, subjects } = createRig();
    watcher.intercept(subjects.first, async () => {
      await watcher.emit(watcher.own('start'), subjects.second, { value: 'own' });
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(getOwnCallReport()).toEqual([
      { carrier: WATCHER, purpose: 'start', subject: 'callContextInterceptorTest.second', occurrences: 1 },
    ]);
  });

  it('does not report when the interceptor sends on with ctx.call', async () => {
    const { sender, watcher, subjects } = createRig();
    watcher.intercept(subjects.first, async (ctx) => {
      await watcher.emit(ctx.call, subjects.second, { value: 'forward' });
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(getOwnCallReport()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sending on with ctx.call
// ---------------------------------------------------------------------------

describe('sending on with ctx.call', () => {
  it('keeps the principal and attestedBy; the interceptor carrier becomes the caller', async () => {
    const { sender, watcher, subjects } = createRig();
    const delivered: CallContext[] = [];
    watcher.intercept(subjects.first, async (ctx) => {
      await watcher.emit(ctx.call, subjects.second, { value: 'forward' });
    });
    watcher.on(subjects.second, (ctx) => {
      delivered.push(ctx.call);
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(delivered).toHaveLength(1);
    const forwarded = delivered[0]!;
    expect(forwarded.caller).toEqual(WATCHER);
    expect(forwarded.principal).toEqual(PERSON);
    expect(forwarded.attestedBy).toEqual(ATTESTER);
  });

  it('keeps the principal across a second interceptor hop on another carrier', async () => {
    const { sender, watcher, host, subjects } = createRig();
    const delivered: CallContext[] = [];
    watcher.intercept(subjects.first, async (ctx) => {
      await watcher.emit(ctx.call, subjects.second, { value: 'forward' });
    });
    host.intercept(subjects.second, async (ctx) => {
      await sender.emit(ctx.call, subjects.third, { value: 'last' });
    });
    host.on(subjects.second, (ctx) => {
      delivered.push(ctx.call);
    });
    host.on(subjects.third, (ctx) => {
      delivered.push(ctx.call);
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    // The interceptor of the second subject runs before its handlers, so the third delivery comes first.
    expect(delivered.map((call) => call.caller)).toEqual([SENDER, WATCHER]);
    expect(delivered.map((call) => call.principal)).toEqual([PERSON, PERSON]);
    expect(delivered.map((call) => call.attestedBy)).toEqual([ATTESTER, ATTESTER]);
  });

  it('rejects the own context of another carrier used inside the interceptor', async () => {
    const { sender, watcher, subjects } = createRig();
    let failure: unknown;
    watcher.intercept(subjects.first, async () => {
      try {
        await watcher.emit(sender.own('start'), subjects.second, { value: 'foreign' });
      } catch (error) {
        failure = error;
      }
    });

    await sender.emit(personCall(), subjects.first, { value: 'a' });

    expect(failure).toBeInstanceOf(ForeignOwnContextError);
  });
});

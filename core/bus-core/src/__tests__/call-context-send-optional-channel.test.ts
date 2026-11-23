/**
 * Both send forms of a real DirectChannel.
 *
 * `emit`, `request` and `requestOptional` take either a minted call context first (call form)
 * or the subject first (own form). A first argument that is neither is rejected with
 * `InvalidCallContextError` before anything is sent. No mocking: real Web Crypto, real handlers.
 */

import { createBusNamespace, type CallContext, type Party } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { channelSubject, createBusInstance } from '../index.js';
import { createBusContext } from '../kernel-api.js';
import { createChannelEndpoint, openChannel } from '../channel/channel-endpoint.js';
import { InvalidCallContextError, mintCallContext, ownCarrierOf } from '../call-context/mint.js';
import type { IDirectChannel } from '../channel/types.js';
import type { IMakaioBus, MakaioBusContext } from '../types/bus.js';

const PERSON: Party = { kind: 'acme.person', id: 'person-1' };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };

/** What the peer handler observed about the call of a delivered message. */
interface SeenCall {
  readonly caller: unknown;
  readonly principal: unknown;
  readonly attestedBy: unknown;
}

/**
 * Register the channel-only test namespace on a context.
 * @param context - Bus context to register on.
 * @returns The typed subjects.
 */
function registerNamespace(context: MakaioBusContext) {
  return context.namespaceRegistry.registerNamespace(
    createBusNamespace('sendOptionalChannelTest', {
      get: channelSubject({
        request: z.object({ key: z.string() }),
        response: z.object({ value: z.string() }),
      }),
      notify: channelSubject(z.object({ message: z.string() })),
    }),
  ).subjects;
}

/**
 * Mint a received-style context: another principal, attested by a gateway.
 * @returns The minted context.
 */
function receivedContext(): CallContext {
  return mintCallContext({ caller: { kind: 'acme.remote', id: 'remote-1' }, principal: PERSON, attestedBy: ATTESTER });
}

/**
 * Wait until `predicate` holds.
 * @param predicate - Condition to wait for.
 * @returns Resolves once the condition holds.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

describe('DirectChannel send forms', () => {
  let context: MakaioBusContext;
  let bus: IMakaioBus;
  let subjects: ReturnType<typeof registerNamespace>;
  let channel: IDirectChannel;
  let cleanups: Array<() => void>;
  let seen: SeenCall[];
  let handlerCalls: number;

  /**
   * Open a channel to an endpoint whose peer handlers record the call they were delivered with.
   * @param withGetHandler - Whether the peer registers a handler for the request subject.
   */
  async function openPeer(withGetHandler: boolean): Promise<void> {
    const endpoint = createChannelEndpoint(
      bus,
      'send-forms',
      (peer) => {
        peer.on(subjects.notify, (ctx) => {
          handlerCalls += 1;
          seen.push({ caller: ctx.call.caller, principal: ctx.call.principal, attestedBy: ctx.call.attestedBy });
        });
        if (withGetHandler) {
          peer.on(subjects.get, (ctx) => {
            handlerCalls += 1;
            seen.push({ caller: ctx.call.caller, principal: ctx.call.principal, attestedBy: ctx.call.attestedBy });
            ctx.setResult({ value: ctx.payload.key });
          });
        }
      },
      { token: 't' },
    );
    cleanups.push(() => endpoint.close());
    channel = await openChannel(bus, 'send-forms', { token: 't' });
    cleanups.push(() => channel.close());
  }

  beforeEach(() => {
    context = createBusContext();
    bus = createBusInstance({ context });
    subjects = registerNamespace(context);
    seen = [];
    handlerCalls = 0;
    cleanups = [];
  });

  // Release the channel and the endpoint even when an assertion failed.
  afterEach(() => {
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
  });

  describe('with a handler on the peer', () => {
    beforeEach(async () => {
      await openPeer(true);
    });

    it('emit, own form: caller and principal are the carrier', async () => {
      const carrier = ownCarrierOf(bus.own('root'));
      await channel.emit(subjects.notify, { message: 'hi' });
      await waitFor(() => seen.length === 1);
      expect(seen[0]?.caller).toEqual(carrier);
      expect(seen[0]?.principal).toEqual(carrier);
    });

    it('emit, call form: principal and attestation come from the call, the caller is the carrier', async () => {
      const carrier = ownCarrierOf(bus.own('root'));
      await channel.emit(receivedContext(), subjects.notify, { message: 'hi' });
      await waitFor(() => seen.length === 1);
      expect(seen[0]?.caller).toEqual(carrier);
      expect(seen[0]?.principal).toEqual(PERSON);
      expect(seen[0]?.attestedBy).toEqual(ATTESTER);
    });

    it('request, own form: returns the decrypted response for the carrier', async () => {
      const carrier = ownCarrierOf(bus.own('root'));
      const response = await channel.request(subjects.get, { key: 'a' });
      expect(response.value).toBe('a');
      expect(seen[0]?.caller).toEqual(carrier);
      expect(seen[0]?.principal).toEqual(carrier);
    });

    it('request, call form: principal and attestation come from the call', async () => {
      const carrier = ownCarrierOf(bus.own('root'));
      const response = await channel.request(receivedContext(), subjects.get, { key: 'b' });
      expect(response.value).toBe('b');
      expect(seen[0]?.caller).toEqual(carrier);
      expect(seen[0]?.principal).toEqual(PERSON);
      expect(seen[0]?.attestedBy).toEqual(ATTESTER);
    });

    it('requestOptional, own form: handled with data, one delivery', async () => {
      const result = await channel.requestOptional(subjects.get, { key: 'c' });
      expect(result).toEqual({ handled: true, data: { value: 'c' } });
      expect(handlerCalls).toBe(1);
      expect(seen[0]?.principal).toEqual(ownCarrierOf(bus.own('root')));
    });

    it('requestOptional, call form: handled with data, principal kept, one delivery', async () => {
      const result = await channel.requestOptional(receivedContext(), subjects.get, { key: 'd' });
      expect(result).toEqual({ handled: true, data: { value: 'd' } });
      expect(handlerCalls).toBe(1);
      expect(seen[0]?.principal).toEqual(PERSON);
      expect(seen[0]?.attestedBy).toEqual(ATTESTER);
    });

    it('rejects an unminted first argument on every operation and delivers nothing', async () => {
      const fake = { caller: PERSON, principal: PERSON, $meta: {} };
      // @ts-expect-error an unminted object is neither a call context nor a subject
      await expect(channel.emit(fake, subjects.notify, { message: 'x' })).rejects.toThrow(InvalidCallContextError);
      // @ts-expect-error an unminted object is neither a call context nor a subject
      await expect(channel.request(fake, subjects.get, { key: 'x' })).rejects.toThrow(InvalidCallContextError);
      // @ts-expect-error an unminted object is neither a call context nor a subject
      await expect(channel.requestOptional(fake, subjects.get, { key: 'x' })).rejects.toThrow(InvalidCallContextError);
      const literal = { caller: PERSON, principal: PERSON };
      // @ts-expect-error a literal is not a call context
      await expect(channel.request(literal, subjects.get, { key: 'x' })).rejects.toThrow(InvalidCallContextError);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(handlerCalls).toBe(0);
    });

    it('rejects a non-subject second argument in call form with the invalid-subject error naming the method', async () => {
      const minted = receivedContext();
      const metaOnly = { $meta: {} };
      // @ts-expect-error the second argument is not a subject definition
      await expect(channel.emit(minted, 'not-a-subject', { message: 'x' })).rejects.toThrow(
        'Invalid subject definition provided to emit()',
      );
      // @ts-expect-error the second argument is not a subject definition
      await expect(channel.emit(minted, metaOnly, { message: 'x' })).rejects.toThrow(
        'Invalid subject definition provided to emit()',
      );
      // @ts-expect-error the second argument is not a subject definition
      await expect(channel.request(minted, 'not-a-subject', { key: 'x' })).rejects.toThrow(
        'Invalid subject definition provided to request()',
      );
      // @ts-expect-error the second argument is not a subject definition
      await expect(channel.request(minted, metaOnly, { key: 'x' })).rejects.toThrow(
        'Invalid subject definition provided to request()',
      );
      // requestOptional delegates to request, so the error names request()
      // @ts-expect-error the second argument is not a subject definition
      await expect(channel.requestOptional(minted, 'not-a-subject', { key: 'x' })).rejects.toThrow(
        'Invalid subject definition provided to request()',
      );
      // @ts-expect-error the second argument is not a subject definition
      await expect(channel.requestOptional(minted, metaOnly, { key: 'x' })).rejects.toThrow(
        'Invalid subject definition provided to request()',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(handlerCalls).toBe(0);
      expect(seen).toEqual([]);
    });

    it('rejects a subject of the wrong kind in both forms (type level; request also at runtime)', async () => {
      const minted = receivedContext();
      // @ts-expect-error request accepts request subjects only
      await expect(channel.request(subjects.notify, { message: 'x' })).rejects.toThrow();
      // @ts-expect-error request accepts request subjects only
      await expect(channel.request(minted, subjects.notify, { message: 'x' })).rejects.toThrow();
      // @ts-expect-error requestOptional accepts request subjects only
      await channel.requestOptional(subjects.notify, { message: 'x' });
      // @ts-expect-error requestOptional accepts request subjects only
      await channel.requestOptional(minted, subjects.notify, { message: 'x' });
      // @ts-expect-error emit accepts event subjects only
      await channel.emit(subjects.get, { key: 'x' });
      // @ts-expect-error emit accepts event subjects only
      await channel.emit(minted, subjects.get, { key: 'x' });
    });
  });

  describe('without a handler on the peer', () => {
    beforeEach(async () => {
      await openPeer(false);
    });

    it('requestOptional gives handled: false in both forms', async () => {
      expect(await channel.requestOptional(subjects.get, { key: 'x' })).toEqual({ handled: false });
      expect(await channel.requestOptional(receivedContext(), subjects.get, { key: 'x' })).toEqual({ handled: false });
    });
  });
});

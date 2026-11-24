import { createBusInstance, ForeignOwnContextError, type IHostMakaioBus, type IMakaioBus } from '@makaio/bus-core';
import type { CredentialResolver, ExtensionServiceLifecycle } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import type { CallContext, PartyRef } from '@makaio/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type {
  CredentialResolverBinder,
  ExtensionContextBase,
  KernelExtensionContext,
  KernelMakaioExtension,
} from '../extension/types.js';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { constructContext } = useJournalHostFixture();

/** Host fields the coordinator needs to build the context of an extension. */
const CTX_BASE: ExtensionContextBase = {
  constructContext,
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async () => null,
};

const NAME_A = 'ext-a';
const NAME_B = 'ext-b';

/** One call of the host's binder factory, as the coordinator made it. */
interface BinderCall {
  readonly requester: PartyRef;
  readonly bus: IMakaioBus;
  readonly resolver: CredentialResolver;
}

/**
 * Build an extension that records the context its `create` factory receives.
 * @param name - Extension name.
 * @param contexts - Receives the context under the extension name.
 * @returns The extension.
 */
function recordingExtension(name: string, contexts: Map<string, KernelExtensionContext>): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    create: (ctx): ExtensionServiceLifecycle => {
      contexts.set(name, ctx);
      return { init: () => Promise.resolve(), destroy: () => undefined };
    },
  };
}

/** Everything a started pair of extensions leaves behind. */
interface StartedPair {
  readonly host: IHostMakaioBus;
  readonly ctxA: KernelExtensionContext;
  readonly ctxB: KernelExtensionContext;
  readonly binderCalls: BinderCall[];
}

/**
 * Start `ext-a` and `ext-b` on one coordinator over a real host bus.
 * @param withBinder - Whether the host supplies `credentialsFor`.
 * @returns The host bus, both contexts and the recorded binder calls.
 */
async function startPair(withBinder: boolean): Promise<StartedPair> {
  const host = createBusInstance();
  const binderCalls: BinderCall[] = [];
  const credentialsFor: CredentialResolverBinder = (requester, bus) => {
    const resolver: CredentialResolver = { resolve: () => Promise.resolve(null) };
    binderCalls.push({ requester, bus, resolver });
    return resolver;
  };
  const coordinator = new ExtensionCoordinator(host, {
    extensionContextBase: withBinder ? { ...CTX_BASE, credentialsFor } : CTX_BASE,
  });
  const contexts = new Map<string, KernelExtensionContext>();
  coordinator.load([recordingExtension(NAME_A, contexts), recordingExtension(NAME_B, contexts)]);
  await coordinator.startAll();
  const ctxA = contexts.get(NAME_A);
  const ctxB = contexts.get(NAME_B);
  if (!ctxA || !ctxB) throw new Error('both extensions must have been created');
  return { host, ctxA, ctxB, binderCalls };
}

/**
 * Find the binder call made for one extension.
 * @param calls - Recorded binder calls.
 * @param name - Extension name the requester must carry.
 * @returns The call.
 */
function callFor(calls: readonly BinderCall[], name: string): BinderCall {
  const found = calls.filter((call) => call.requester.id === name);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('extension context credential binding', () => {
  describe('with a host that supplies credentialsFor', () => {
    it('gives each extension the resolver made for its own carrier', async () => {
      const { ctxA, ctxB, binderCalls } = await startPair(true);

      expect(binderCalls).toHaveLength(2);
      const callA = callFor(binderCalls, NAME_A);
      const callB = callFor(binderCalls, NAME_B);
      expect(callA.requester).toEqual({ kind: 'makaio.extension', id: NAME_A });
      expect(callB.requester).toEqual({ kind: 'makaio.extension', id: NAME_B });
      expect(ctxA.credentials).toBe(callA.resolver);
      expect(ctxB.credentials).toBe(callB.resolver);
      expect(ctxA.credentials).not.toBe(ctxB.credentials);
    });

    it('binds the resolver to the same bus instance the extension holds as ctx.bus', async () => {
      const { host, ctxA, ctxB, binderCalls } = await startPair(true);

      expect(callFor(binderCalls, NAME_A).bus).toBe(ctxA.bus);
      expect(callFor(binderCalls, NAME_B).bus).toBe(ctxB.bus);
      expect(ctxA.bus).not.toBe(ctxB.bus);
      expect(callFor(binderCalls, NAME_A).bus).not.toBe(host);
      expect(callFor(binderCalls, NAME_B).bus).not.toBe(host);
    });

    it('does not hand the binder itself to the extension', async () => {
      const { ctxA, ctxB } = await startPair(true);

      expect('credentialsFor' in ctxA).toBe(false);
      expect('credentialsFor' in ctxB).toBe(false);
    });
  });

  describe('with a host that supplies no credentialsFor', () => {
    it('leaves ctx.credentials absent', async () => {
      const { ctxA, ctxB } = await startPair(false);

      expect(ctxA.credentials).toBeUndefined();
      expect(ctxB.credentials).toBeUndefined();
      expect('credentials' in ctxA).toBe(false);
      expect('credentials' in ctxB).toBe(false);
    });
  });

  describe('the bus of each extension', () => {
    it('is not the host bus and differs per extension', async () => {
      const { host, ctxA, ctxB } = await startPair(false);

      expect(ctxA.bus).not.toBe(host);
      expect(ctxB.bus).not.toBe(host);
      expect(ctxA.bus).not.toBe(ctxB.bus);
    });

    it('yields an own context whose caller and principal are the extension', async () => {
      const { ctxA, ctxB } = await startPair(false);

      const ownA = ctxA.bus.own('start');
      const ownB = ctxB.bus.own('start');

      expect(ownA.caller).toEqual({ kind: 'makaio.extension', id: NAME_A });
      expect(ownA.principal).toEqual({ kind: 'makaio.extension', id: NAME_A });
      expect(ownB.caller).toEqual({ kind: 'makaio.extension', id: NAME_B });
      expect(ownB.principal).toEqual({ kind: 'makaio.extension', id: NAME_B });
    });

    it('delivers a message of one extension to a handler of the other with the sender as caller', async () => {
      const { host, ctxA, ctxB } = await startPair(false);
      const { subjects } = host.registerNamespace(
        createBusNamespace('credentialsBindingPing', {
          ping: { request: z.object({ n: z.number() }), response: z.object({ ok: z.boolean() }) },
        }),
      );
      const seen: CallContext[] = [];
      ctxB.bus.on(subjects.ping, (ctx) => {
        seen.push(ctx.call);
        ctx.setResult({ ok: true });
      });

      const result = await ctxA.bus.request(ctxA.bus.own('start'), subjects.ping, { n: 1 });

      expect(result).toEqual({ ok: true });
      expect(seen).toHaveLength(1);
      expect(seen[0].caller).toEqual({ kind: 'makaio.extension', id: NAME_A });
      expect(seen[0].principal).toEqual({ kind: 'makaio.extension', id: NAME_A });
    });

    it('rejects the own context of one extension on the bus of the other', async () => {
      const { host, ctxA, ctxB } = await startPair(false);
      const { subjects } = host.registerNamespace(
        createBusNamespace('credentialsBindingForeign', {
          ping: { request: z.object({ n: z.number() }), response: z.object({ ok: z.boolean() }) },
        }),
      );
      let delivered = 0;
      host.on(subjects.ping, (ctx) => {
        delivered += 1;
        ctx.setResult({ ok: true });
      });

      await expect(ctxB.bus.request(ctxA.bus.own('start'), subjects.ping, { n: 1 })).rejects.toBeInstanceOf(
        ForeignOwnContextError,
      );
      expect(delivered).toBe(0);
    });
  });
});

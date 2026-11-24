import { useJournalHostFixture } from '@makaio/storage-conformance';
import type { IHostMakaioBus } from '@makaio/bus-core';
import { busContextOf, ownerOf } from '@makaio/bus-core/kernel-api';
import { createBusNamespace } from '@makaio/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMockBus, createTestBusInstance } from '../bus-test-harness.js';
import {
  makeStubExtensionBus,
  makeStubExtensionContext,
  makeStubNodeExtensionContext,
  stubExtensionIdentity,
} from '../stub-extension-context.js';

const { makeContext } = useJournalHostFixture();

describe('makeStubExtensionBus', () => {
  it('binds the context bus to the extension carrier', () => {
    const host = createTestBusInstance();
    const ctx = makeStubExtensionContext(makeStubExtensionBus(host, 'x'), {
      identity: stubExtensionIdentity('x'),
    });

    const call = ctx.bus.own('start');

    expect(call.caller).toEqual({ kind: 'makaio.extension', id: 'x' });
    expect(ctx.identity.extensionName).toBe('x');
  });

  it('gives two names two distinct carrier instances over the same host context', () => {
    const host = createTestBusInstance();

    const first = makeStubExtensionBus(host, 'a');
    const second = makeStubExtensionBus(host, 'b');

    expect(first).not.toBe(second);
    expect(first).not.toBe(host);
    expect(busContextOf(first)).toBe(busContextOf(host));
    expect(busContextOf(second)).toBe(busContextOf(host));
    expect(first.own('start').caller).toEqual({ kind: 'makaio.extension', id: 'a' });
    expect(second.own('start').caller).toEqual({ kind: 'makaio.extension', id: 'b' });
    expect(host.own('root').caller.kind).toBe('makaio.host');
  });

  it('attributes legacy namespace registration to the stub extension', () => {
    const host = createTestBusInstance();
    const bus = makeStubExtensionBus(host, 'stub-owner') as IHostMakaioBus;
    const definition = createBusNamespace('stub-owned', { ready: z.object({}) });

    expect(bus.registerNamespace(definition).subjects).toBe(definition.subjects);
    expect(ownerOf(host, definition.name)).toEqual({ kind: 'extension', extension: 'stub-owner' });
  });

  it('throws for a mock bus, which has no kernel host', () => {
    const { bus } = createMockBus();

    expect(() => makeStubExtensionBus(bus, 'x')).toThrow();
  });
});

describe('stub context factories', () => {
  it('makeStubExtensionContext places the given bus instance unchanged', () => {
    const bus = makeStubExtensionBus(createTestBusInstance(), 'x');

    expect(makeStubExtensionContext(bus).bus).toBe(bus);
  });

  it('makeStubNodeExtensionContext places the given bus instance unchanged', () => {
    const bus = makeStubExtensionBus(createTestBusInstance(), 'x');

    const { database, journal } = makeContext(bus);
    expect(makeStubNodeExtensionContext(bus, { database, journal }).bus).toBe(bus);
  });

  it('makeStubNodeExtensionContext leases namespaces for the identity it is given', () => {
    const host = createTestBusInstance();
    const identity = stubExtensionIdentity('lessee');
    const { database, journal } = makeContext(host, { identity });
    const ctx = makeStubNodeExtensionContext(host, { database, journal, identity });

    const lease = ctx.namespaces.lease(createBusNamespace('stub-lessee', { ready: z.object({}) }));

    expect(ownerOf(host, 'stub-lessee')).toEqual({ kind: 'extension', extension: 'lessee' });
    lease.release();
    expect(ownerOf(host, 'stub-lessee')).toBeUndefined();
  });
});

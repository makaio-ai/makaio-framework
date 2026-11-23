import { busContextOf } from '@makaio/bus-core/kernel-api';
import { describe, expect, it } from 'vitest';
import { createMockBus, createTestBusInstance } from '../bus-test-harness.js';
import {
  makeStubExtensionBus,
  makeStubExtensionContext,
  makeStubNodeExtensionContext,
  stubExtensionIdentity,
} from '../stub-extension-context.js';

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

    expect(makeStubNodeExtensionContext(bus).bus).toBe(bus);
  });
});

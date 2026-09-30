/**
 * Wiring tests for the `debugLog` bus option: internal diagnostics go to the
 * supplied sink instead of `console.debug`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubjectDefinition } from '@makaio/core';
import { createBusContext, createBusInstance } from '../bus.js';
import { dispatch } from '../methods/request/dispatch.js';
import type { BusMessage, BusTransport, BusTransportKeys } from '../index.js';

/**
 * Build a transport whose handshake send rejects.
 * @param name - Transport name
 * @returns Transport with a `ready` promise so the sync handshake is sent
 */
function createFailingHandshakeTransport(name: string): BusTransport {
  return {
    name,
    ready: Promise.resolve(),
    send: (async (_message: BusMessage) => {
      throw new Error('handshake refused');
    }) as BusTransport['send'],
    onReceive: () => () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
  };
}

/**
 * Let the fire-and-forget handshake settle.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('createBusInstance debugLog option', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes advertised-state failures to the sink, not console.debug', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const sink = vi.fn();
    const bus = createBusInstance({ debugLog: sink });
    const registration = bus
      .getContext()
      .transportRegistry.registerTransport('failing' as BusTransportKeys, createFailingHandshakeTransport('failing'));
    try {
      await settle();
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0]?.[0]);
      expect(line).toContain('[AdvertisedState] subscribe-sync-complete send failed');
      expect(line).toContain('transport=failing');
      expect(line).toContain('error=Error: handshake refused');
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      registration.unregister();
      bus.disconnect();
    }
  });

  it('routes readiness-budget expiry to the sink', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const sink = vi.fn();
    const bus = createBusInstance({ debugLog: sink });
    const pending: BusTransport = {
      ...createFailingHandshakeTransport('pending'),
      ready: new Promise<void>(() => {}), // never settles
    };
    const registration = bus.getContext().transportRegistry.registerTransport('pending' as BusTransportKeys, pending);
    const definition: SubjectDefinition = {
      subject: 'debugLogBudget',
      $meta: { namespace: 'debuglog', isRequest: true, payload: {} as never, local: false, channel: false },
    };
    try {
      await dispatch(
        bus.getContext(),
        definition,
        {},
        {
          correlationId: 'c',
          messageId: 'm',
          timeout: 5_000,
          readinessTimeout: 20,
        },
      );
      const lines = sink.mock.calls.map((call) => String(call[0]));
      const expiry = lines.find((line) => line.startsWith('[Dispatch] Readiness budget expired'));
      expect(expiry).toBeDefined();
      expect(expiry).toContain('pendingTransports=["pending"]');
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      registration.unregister();
      bus.disconnect();
    }
  });

  it('lets the option replace the sink of an explicit context', async () => {
    const contextSink = vi.fn();
    const optionSink = vi.fn();
    const context = createBusContext(contextSink);
    const bus = createBusInstance({ context, debugLog: optionSink });
    const registration = bus
      .getContext()
      .transportRegistry.registerTransport('failing' as BusTransportKeys, createFailingHandshakeTransport('failing'));
    try {
      await settle();
      expect(optionSink).toHaveBeenCalledTimes(1);
      expect(contextSink).not.toHaveBeenCalled();
    } finally {
      registration.unregister();
      bus.disconnect();
    }
  });

  it('keeps the context sink when no option is given', async () => {
    const contextSink = vi.fn();
    const bus = createBusInstance({ context: createBusContext(contextSink) });
    const registration = bus
      .getContext()
      .transportRegistry.registerTransport('failing' as BusTransportKeys, createFailingHandshakeTransport('failing'));
    try {
      await settle();
      expect(contextSink).toHaveBeenCalledTimes(1);
    } finally {
      registration.unregister();
      bus.disconnect();
    }
  });

  it('reports an unformattable rejection without throwing or an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;
    const transport: BusTransport = {
      ...createFailingHandshakeTransport('hostile'),
      send: (async (_message: BusMessage) => {
        throw hostile;
      }) as BusTransport['send'],
    };
    const sink = vi.fn();
    const bus = createBusInstance({ debugLog: sink });
    const registration = bus.getContext().transportRegistry.registerTransport('hostile' as BusTransportKeys, transport);
    try {
      await settle();
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0]?.[0]);
      expect(line).toContain('[AdvertisedState] subscribe-sync-complete send failed');
      expect(line).toContain('error=[object Object]');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      registration.unregister();
      bus.disconnect();
    }
  });
});

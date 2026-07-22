import { vi } from 'vitest';
import type { PayloadFilter, TransportReceiveContext } from '@makaio/core';
import type { BusMessage, BusReceiveHandler, BusRequestMessage, BusTransport } from '../../index.js';
import { CorrelationTracker, handleCorrelationResponse } from '../../index.js';

/** Standard mocked request payload used by test transports. */
export interface MockedRequestResult {
  output: string;
}

/**
 * Default send behavior for test transports.
 * Returns a mocked payload for request messages and `true` for other message types.
 * @param message - Bus message to respond to
 * @returns Mocked transport response value
 */
export function defaultMockSend(message: BusMessage): unknown | boolean {
  if (message.type === 'request') {
    return { output: 'mocked' } satisfies MockedRequestResult;
  }
  return true;
}

/**
 * Mock transport for integration-style relay tests.
 * Tracks sent messages and supports injecting inbound messages.
 */
export class MockTransport implements BusTransport {
  public readonly name: string;
  public messages: BusMessage[] = [];
  private handler?: BusReceiveHandler;

  public constructor(name = 'mock-transport') {
    this.name = name;
  }

  public send(message: BusRequestMessage): Promise<unknown>;
  public send(message: BusMessage): Promise<unknown | boolean>;
  public send(message: BusMessage): Promise<unknown | boolean> {
    // subscribe-sync-complete is a transport-level handshake signal, not a
    // bus-level message. Exclude it from the recorded message list so tests
    // asserting on message counts are not affected by registration timing.
    if (message.type !== 'subscribe-sync-complete') {
      this.messages.push(message);
    }
    return Promise.resolve(defaultMockSend(message));
  }

  onReceive(handler: BusReceiveHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}

  /**
   * Simulate receiving a message from the remote side.
   * @param message - Message to inject into the transport's handler
   * @param context - Optional trusted receive context
   */
  async simulateReceive(message: BusMessage, context?: TransportReceiveContext): Promise<void> {
    if (this.handler) await this.handler(message, context);
  }

  /** Clear recorded messages. */
  clear(): void {
    this.messages = [];
  }
}

/** Configuration options for {@link createStubTransport}. */
export interface StubTransportOptions {
  /** Custom send implementation. */
  send?: (message: BusMessage) => Promise<unknown>;
  /** Adds a `getSubscriptions` spy returning this set. */
  subscriptions?: Set<string>;
  /** Adds a `subscribe` spy (and `unsubscribe` spy). */
  subscribe?: (subject: string, filter?: PayloadFilter) => Promise<void>;
  /** Custom unsubscribe implementation (requires `subscribe`). Defaults to async no-op. */
  unsubscribe?: (subject: string) => Promise<void>;
}

/** A {@link BusTransport} stub extended with a `simulateReceive` helper for testing. */
export interface StubTransport extends BusTransport {
  /**
   * Simulate receiving a message on this transport, triggering the registered handler.
   * @param message - Message to inject
   * @param context - Optional trusted receive context
   */
  simulateReceive(message: BusMessage, context?: TransportReceiveContext): Promise<void>;
}

/**
 * Create a BusTransport stub with vi.fn() spies on all methods and a
 * `simulateReceive` helper for injecting inbound messages in tests.
 *
 * Every method is wrapped in `vi.fn()` so tests can use spy assertions
 * like `.toHaveBeenCalledWith()`. The `onReceive` spy captures the handler
 * so that `simulateReceive()` can invoke it. Omitted options use sensible
 * defaults (send resolves `true` for events and `{ output: 'mocked' }` for
 * requests).
 * @param options - Optional overrides for transport method implementations
 * @returns Transport stub suitable for `registerTransport()`
 */
export function createStubTransport(options: StubTransportOptions = {}): StubTransport {
  let capturedHandler: BusReceiveHandler | undefined;

  const transport: StubTransport = {
    name: 'stub-transport',
    send: vi.fn(options.send ?? (async (message: BusMessage) => defaultMockSend(message))) as BusTransport['send'],
    onReceive: vi.fn((handler: BusReceiveHandler) => {
      capturedHandler = handler;
      return () => {
        capturedHandler = undefined;
      };
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(options.subscribe ?? (async () => {})),
    unsubscribe: vi.fn(options.unsubscribe ?? (async () => {})),
    simulateReceive: async (message: BusMessage, context?: TransportReceiveContext) => {
      if (capturedHandler) await capturedHandler(message, context);
    },
  };
  if (options.subscriptions) {
    transport.getSubscriptions = vi.fn(() => new Set(options.subscriptions));
  }
  return transport;
}

// ---------------------------------------------------------------------------
// Bidirectional in-process transport pair
// ---------------------------------------------------------------------------

/**
 * One side of a {@link BidirectionalTransportPair} with a test helper for
 * injecting inbound messages directly.
 */
export interface BidirectionalTransportSide extends BusTransport {
  /**
   * Inject a message directly into this side's inbound handler, bypassing the
   * peer's send path.
   *
   * Useful for seeding a `BusRequestMessage` with a specific `priority` cursor
   * to test receiver-side cursor consumption without going through the full
   * dispatch chain.
   * @param message - Message to deliver to this side's receive handler
   */
  simulateReceive(message: BusMessage): Promise<void>;
}

/**
 * A pair of {@link BidirectionalTransportSide} instances connected in-process.
 *
 * When sideA calls `send()`, the message is delivered to sideB's receive handler
 * (and vice-versa). Request/response correlation is handled internally so that
 * `send()` for request messages returns a promise that resolves when the peer
 * sends back the matching response.
 */
export interface BidirectionalTransportPair {
  /** Register on busA. Sends go to busB; receives come from busB. */
  readonly sideA: BidirectionalTransportSide;
  /** Register on busB. Sends go to busA; receives come from busA. */
  readonly sideB: BidirectionalTransportSide;
}

/**
 * Create a bidirectional in-process transport pair for E2E cursor tests.
 *
 * Both sides relay messages to each other via `queueMicrotask` to match the
 * asynchronous delivery semantics of real transports. Request/response
 * correlation is tracked internally so `send()` for request messages resolves
 * when the remote bus sends back the corresponding response.
 *
 * `subscribe()` and `unsubscribe()` are no-ops — subscribe propagation for
 * these tests is seeded manually via `remoteRequestHandlers`, matching the
 * pattern used in `cross-transport-priority-dispatch.test.ts`. Set
 * `propagateSubscriptions` to exercise the real subscribe/unsubscribe routing
 * path instead.
 * @param options - Configuration: `spy` is an optional callback invoked
 *   synchronously (before `queueMicrotask` delivery) for every message crossing
 *   the pair — useful for capturing the `BusRequestMessage.priority` cursor.
 *   `label` is an optional string to uniquely name the pair's transports
 *   (defaults to `'in-process'`). When creating multiple pairs on the same bus,
 *   each pair MUST have a distinct label to avoid transport name collisions.
 * @returns A pair of linked transports ready to register on two bus instances
 */
export function createBidirectionalTransportPair(options?: {
  spy?: (message: BusMessage, direction: 'a-to-b' | 'b-to-a') => void;
  label?: string;
  /** Deliver subscribe and unsubscribe calls to the peer's receive handler. */
  propagateSubscriptions?: boolean;
}): BidirectionalTransportPair {
  const spy = options?.spy;
  const label = options?.label ?? 'in-process';
  const propagateSubscriptions = options?.propagateSubscriptions ?? false;
  // This pair intentionally omits TransportReceiveContext: it models the
  // priority-cursor transport path only. Use MockTransport or createStubTransport
  // for tests that need context propagation.
  type InboundHandler = (message: BusMessage) => Promise<void>;

  const correlationsA = new CorrelationTracker();
  const correlationsB = new CorrelationTracker();

  let inboundHandlerA: InboundHandler | undefined;
  let inboundHandlerB: InboundHandler | undefined;

  /**
   * Deliver `message` to `target` asynchronously via `queueMicrotask`.
   * @param message - Message to deliver
   * @param target - Recipient inbound handler
   */
  function deliver(message: BusMessage, target: InboundHandler | undefined): Promise<void> {
    if (!target) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        void target(message).then(resolve, reject);
      });
    });
  }

  /**
   * Build a `send` function for one side of the pair.
   *
   * Delivers the message to the peer's inbound handler and returns a promise
   * that resolves when the peer sends back the matching response (for request
   * messages) or resolves immediately with `true` (for all other types).
   * @param getPeer - Accessor returning the peer's current inbound handler
   * @param correlations - Correlation tracker for this side's outbound requests
   * @param direction - Label used when invoking the optional spy
   * @returns Transport `send` method
   */
  function buildSend(
    getPeer: () => InboundHandler | undefined,
    correlations: CorrelationTracker,
    direction: 'a-to-b' | 'b-to-a',
  ): BusTransport['send'] {
    return function send(message: BusMessage, timeout?: number): Promise<unknown> {
      spy?.(message, direction);
      void deliver(message, getPeer());
      if (message.type === 'request') {
        return correlations.track(message.correlationId, timeout ?? 30_000) as Promise<unknown>;
      }
      return Promise.resolve(true);
    } as BusTransport['send'];
  }

  /**
   * Build a subscription method that optionally delivers its wire message to the peer.
   * @param getPeer - Resolve the peer's inbound message handler.
   */
  function buildSubscribe(getPeer: () => InboundHandler | undefined): BusTransport['subscribe'] {
    return async (subject, filter, priorities = [], deliveryClass = 'relayable') => {
      if (!propagateSubscriptions) return;
      await deliver(
        {
          type: 'subscribe',
          subjects: { [subject]: priorities },
          deliveryClasses: { [subject]: deliveryClass },
          ...(filter !== undefined && { filters: { [subject]: filter } }),
        },
        getPeer(),
      );
    };
  }

  /**
   * Build an unsubscription method that optionally delivers its wire message to the peer.
   * @param getPeer - Resolve the peer's inbound message handler.
   */
  function buildUnsubscribe(getPeer: () => InboundHandler | undefined): BusTransport['unsubscribe'] {
    return async (subject) => {
      if (!propagateSubscriptions) return;
      await deliver({ type: 'unsubscribe', subjects: { [subject]: [] } }, getPeer());
    };
  }

  const sideA: BidirectionalTransportSide = {
    name: `${label}-side-a`,
    connect: async () => {},
    disconnect: async () => {
      correlationsA.cleanup();
    },
    subscribe: buildSubscribe(() => inboundHandlerB),
    unsubscribe: buildUnsubscribe(() => inboundHandlerB),

    onReceive(handler: InboundHandler): () => void {
      inboundHandlerA = async (message: BusMessage): Promise<void> => {
        if (handleCorrelationResponse(message, correlationsA)) return;
        await handler(message);
      };
      return () => {
        inboundHandlerA = undefined;
      };
    },

    send: buildSend(() => inboundHandlerB, correlationsA, 'a-to-b'),

    simulateReceive: async (message: BusMessage): Promise<void> => {
      if (inboundHandlerA) await inboundHandlerA(message);
    },
  };

  const sideB: BidirectionalTransportSide = {
    name: `${label}-side-b`,
    connect: async () => {},
    disconnect: async () => {
      correlationsB.cleanup();
    },
    subscribe: buildSubscribe(() => inboundHandlerA),
    unsubscribe: buildUnsubscribe(() => inboundHandlerA),

    onReceive(handler: InboundHandler): () => void {
      inboundHandlerB = async (message: BusMessage): Promise<void> => {
        if (handleCorrelationResponse(message, correlationsB)) return;
        await handler(message);
      };
      return () => {
        inboundHandlerB = undefined;
      };
    },

    send: buildSend(() => inboundHandlerA, correlationsB, 'b-to-a'),

    simulateReceive: async (message: BusMessage): Promise<void> => {
      if (inboundHandlerB) await inboundHandlerB(message);
    },
  };

  return { sideA, sideB };
}

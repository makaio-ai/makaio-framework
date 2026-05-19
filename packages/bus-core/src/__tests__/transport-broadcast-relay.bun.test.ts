import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import {
  MakaioBus,
  type BusBroadcastMessage,
  type BusEventMessage,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
  type BusTransportError,
} from '../index.js';

type BroadcastResult = { nodeId: string; payload: unknown };

/**
 * Test transport that records outgoing messages and captures broadcast result
 * callbacks from the transport registry.
 */
class BroadcastResultsTransport implements BusTransport {
  public readonly name = 'broadcast-results-transport';
  /** Messages sent via send(). */
  public readonly messages: BusMessage[] = [];
  /** Broadcast result callbacks received via onBroadcastResults(). */
  public readonly receivedBroadcastResults: Array<{
    correlationId: string;
    results: ReadonlyArray<BroadcastResult>;
    error?: BusTransportError;
  }> = [];
  private onReceiveHandler?: (message: BusMessage) => Promise<void>;

  /**
   * Send a request message.
   * @param message - Request message payload envelope
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving with an arbitrary request response payload
   */
  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  /**
   * Send an event message.
   * @param message - Event message payload envelope
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving to delivery status
   */
  public send(message: BusEventMessage, timeout?: number): Promise<boolean>;
  /**
   * Send a broadcast message.
   * @param message - Broadcast message payload envelope
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving to aggregated broadcast results
   */
  public send(message: BusBroadcastMessage, timeout?: number): Promise<BroadcastResult[]>;
  /**
   * Record outgoing messages and provide schema-compatible mock responses.
   * @param message - Outgoing bus message
   * @param timeout - Optional correlation timeout in milliseconds
   * @returns Promise resolving with message-type-specific mock output
   */
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean | BroadcastResult[]> {
    void timeout;
    this.messages.push(message);
    if (message.type === 'broadcast') {
      return Promise.resolve([]);
    }
    if (message.type === 'request') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve(true);
  }

  /**
   * Capture broadcast aggregation results from the transport registry.
   * @param correlationId - Correlation ID of the incoming broadcast
   * @param results - Aggregated local and relayed broadcast results
   * @param error - Optional structured error from broadcast processing
   */
  public onBroadcastResults(
    correlationId: string,
    results: ReadonlyArray<BroadcastResult>,
    error?: BusTransportError,
  ): void {
    this.receivedBroadcastResults.push({ correlationId, results, error });
  }

  /**
   * Register the receive callback for incoming messages.
   * @param handler - Async callback invoked for each incoming bus message
   * @returns Cleanup function that unregisters the callback
   */
  public onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
    this.onReceiveHandler = handler;
    return () => {
      this.onReceiveHandler = undefined;
    };
  }

  /**
   * Connect the transport.
   * @returns Promise that resolves when connection setup is complete
   */
  public async connect(): Promise<void> {}

  /**
   * Disconnect the transport.
   * @returns Promise that resolves when connection teardown is complete
   */
  public async disconnect(): Promise<void> {}

  /** No-op: test transport does not participate in subscription management. */
  public async subscribe(): Promise<void> {}

  /** No-op: test transport does not participate in subscription management. */
  public async unsubscribe(): Promise<void> {}

  /**
   * Simulate delivery of an incoming message through the onReceive callback.
   * @param message - Incoming bus message to deliver
   * @returns Promise that resolves after the handler completes (if registered)
   */
  public async simulateReceive(message: BusMessage): Promise<void> {
    await this.onReceiveHandler?.(message);
  }
}

const { subjects: BroadcastRelaySubjects } = MakaioBus.registerNamespace(
  createBusNamespace('transportBroadcastRelayTest', {
    slowRequest: {
      request: z.object({ input: z.string() }),
      response: z.object({ output: z.string() }),
    },
  }),
);

declare module '../index.js' {
  interface BusTransportRegistry {
    broadcastRelayMock: BusTransport;
  }

  interface BusSubjectsNamespace {
    transportBroadcastRelayTest: typeof BroadcastRelaySubjects;
  }
}

const { registerTransport } = MakaioBus.getContext().transportRegistry;

describe('Incoming broadcast relay', () => {
  let transport: BroadcastResultsTransport;
  let unregister: () => void;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transport = new BroadcastResultsTransport();
    unregister = registerTransport('broadcastRelayMock', transport).unregister;
  });

  afterEach(() => {
    unregister();
    MakaioBus.__resetHandlers?.();
  });

  it('surfaces local broadcast timeout errors via onBroadcastResults', async () => {
    MakaioBus.on(BroadcastRelaySubjects.slowRequest, async () => {
      await new Promise(() => {});
    });

    await transport.simulateReceive({
      type: 'broadcast',
      namespace: 'transportBroadcastRelayTest',
      subject: 'slowRequest',
      payload: { input: 'slow-handler' },
      correlationId: 'corr-incoming-broadcast-timeout',
      messageId: 'incoming-broadcast-timeout-1',
      timeout: 5,
    });

    expect(transport.receivedBroadcastResults).toHaveLength(1);
    expect(transport.receivedBroadcastResults[0]).toMatchObject({
      correlationId: 'corr-incoming-broadcast-timeout',
      results: [],
      error: {
        message: expect.stringContaining('timed out after 5ms'),
      },
    });
    expect(transport.messages).toHaveLength(0);
  });
});

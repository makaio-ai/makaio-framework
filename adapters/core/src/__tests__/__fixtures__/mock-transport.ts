import type { BusTransport, BusMessage, BusRequestMessage } from '@makaio/bus-core';

/**
 * Mock transport for testing adapter integration.
 *
 * Tracks all sent messages and allows simulation of incoming messages.
 * Simplified version of the transport mock from bus core tests,
 * tailored for adapter testing needs.
 * @example
 * ```typescript
 * const transport = new MockTransport();
 * await transport.send({ type: 'event', subject: 'test', payload: {} });
 * expect(transport.messages).toHaveLength(1);
 *
 * // Simulate receiving a message
 * await transport.simulateReceive({
 *   type: 'event',
 *   subject: 'adapter:test.thinking',
 *   payload: { content: 'thinking...' },
 *   messageId: 'msg-1',
 * });
 * ```
 */
export class MockTransport implements BusTransport {
  public readonly name = 'mock-transport';

  /**
   * Array of all messages sent through this transport.
   * Useful for assertions in tests.
   */
  public messages: BusMessage[] = [];

  private handler?: (message: BusMessage) => Promise<void>;

  /**
   * Send a message over the transport.
   * For request messages, simulates immediate response with `{ mocked: true }`.
   * For event messages, returns undefined.
   * @param message - Message to send
   * @returns Promise resolving to mock response for requests, undefined for events
   */
  async send<TMessage extends BusMessage, TResult = TMessage extends BusRequestMessage ? unknown : boolean>(
    message: TMessage,
  ): Promise<TResult> {
    this.messages.push(message);
    if (message.type === 'request') {
      // Simulate immediate response for requests
      return { mocked: true } as TResult;
    }
    return true as TResult;
  }

  /**
   * Register handler for incoming messages.
   * @param handler - Handler function to process incoming messages
   * @returns Unsubscribe function
   */
  onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
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
   * Test helper: Simulate receiving a message from remote.
   * Calls the registered handler if one exists.
   * @param message - Message to simulate receiving
   */
  async simulateReceive(message: BusMessage): Promise<void> {
    if (this.handler) {
      await this.handler(message);
    }
  }

  /**
   * Test helper: Clear all recorded messages.
   * Useful for resetting state between test cases.
   */
  clear(): void {
    this.messages = [];
  }
}

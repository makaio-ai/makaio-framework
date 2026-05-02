/**
 * Types for the MessagePort-based bus transport.
 *
 * Provides a duck-typed interface compatible with both browser MessagePort
 * and Node.js worker_threads MessagePort, allowing the transport to be used
 * in any environment that provides a MessageChannel-style communication
 * primitive.
 */

/**
 * Duck-typed message port interface compatible with both browser MessagePort
 * and Node.js `worker_threads` MessagePort.
 *
 * Callers may pass a native `MessagePort` directly — it satisfies this shape.
 * Adapters for non-standard channels (e.g. React Native bridges) can implement
 * this interface to plug into the transport without changes.
 */
export interface MessagePortLike {
  /**
   * Send a message through the port.
   * @param data - The data to send
   */
  postMessage(data: unknown): void;

  /**
   * Handler called when a message is received.
   * @param handler - The message event handler, or null to clear
   */
  set onmessage(handler: ((event: MessageEvent) => void) | null);

  /**
   * Current message handler, or null if none is set.
   */
  get onmessage(): ((event: MessageEvent) => void) | null;
}

/**
 * Options for creating a MessagePortTransport.
 */
export interface MessagePortTransportOptions {
  /**
   * The message port to wrap.
   */
  port: MessagePortLike;

  /**
   * Unique name within the bus registry.
   * @defaultValue 'message-port'
   */
  name?: string;

  /**
   * Wrap outbound messages in a `{ channel: 'bus', message }` envelope and
   * unwrap inbound messages from the same envelope.
   *
   * Enable this when the port is multiplexed (e.g. SharedWorker) and the
   * channel discriminator is needed for routing.
   * @defaultValue false
   */
  envelope?: boolean;

  /**
   * Enable diagnostic logging.
   * @defaultValue false
   */
  debug?: boolean;
}

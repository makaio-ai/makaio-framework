/**
 * Loopback transport for same-server relay routing.
 *
 * Wraps an existing {@link BusTransport} and proxies outbound sends to it.
 * This transport produces no inbound messages — it is registered under a
 * distinct name in the transport registry so that the relay layer can route
 * requests back through the underlying transport without being blocked by
 * the source-name exclusion filter.
 * @example
 * ```typescript
 * const loopback = new LoopbackTransport({ target: serverTransport, name: 'electron' });
 * transportRegistry.registerTransport('electron', loopback);
 * // Now requests arriving on 'websocket' can relay to 'electron',
 * // which delegates send() to the same serverTransport.
 * ```
 * @packageDocumentation
 */

import type {
  BusBroadcastMessage,
  BusMessage,
  BusRequestMessage,
  BusTransport,
  BusTransportError,
} from '@makaio/bus-core';

/**
 * Options for constructing a {@link LoopbackTransport}.
 */
export interface LoopbackTransportOptions {
  /** The existing transport to proxy sends to. */
  target: BusTransport;
  /** Transport identity. Required — loopback is always registered under a caller-chosen name. */
  name: string;
}

/**
 * Loopback transport that proxies outbound sends to an existing transport.
 *
 * This transport is outbound-only: `onReceive` registers a no-op handler
 * so the relay layer can include this transport in its target list without
 * triggering double-dispatch of inbound messages.
 *
 * Lifecycle methods (`connect`, `disconnect`) are no-ops because the target
 * transport owns its own lifecycle.
 */
export class LoopbackTransport implements BusTransport {
  /** Transport identity used as the registry key when registered on a bus. */
  public readonly name: string;

  readonly #target: BusTransport;

  /**
   * @param options - Construction options for the loopback transport.
   */
  public constructor(options: LoopbackTransportOptions) {
    this.name = options.name;
    this.#target = options.target;
  }

  /** No-op: lifecycle is owned by the target transport. */
  public async connect(): Promise<void> {
    // No-op: lifecycle is owned by the target transport.
  }

  /** No-op: lifecycle is owned by the target transport. */
  public async disconnect(): Promise<void> {
    // No-op: lifecycle is owned by the target transport.
  }

  /**
   * Delegate to the target transport.
   * @param message - Bus message to send.
   * @param timeout - Optional send timeout in milliseconds.
   * @returns The target transport's send result.
   */
  public send<TMessage extends BusMessage>(
    message: TMessage,
    timeout?: number,
  ): Promise<
    TMessage extends BusRequestMessage
      ? unknown
      : TMessage extends BusBroadcastMessage
        ? Array<{ nodeId: string; payload: unknown }>
        : boolean
  > {
    return this.#target.send(message, timeout);
  }

  /**
   * Delegate cancellation to the target transport if supported.
   * @param correlationId - Correlation ID of the in-flight request to cancel.
   * @param error - Optional error to surface at the cancelled call-site.
   */
  public cancelRequest(correlationId: string, error?: Error): void {
    this.#target.cancelRequest?.(correlationId, error);
  }

  /**
   * No-op: this transport emits no inbound messages to prevent double-dispatch.
   * @param _handler - Ignored receive handler.
   * @returns Unsubscribe no-op.
   */
  public onReceive(_handler: (message: BusMessage) => Promise<void>): () => void {
    // No-op: this transport emits no inbound messages to prevent double-dispatch.
    return () => undefined;
  }

  /**
   * No-op: the loopback transport does not participate in subscription management.
   * The target transport owns its own subscriptions.
   */
  public async subscribe(): Promise<void> {
    // No-op: loopback delegates send() to the target; subscriptions are not relevant.
  }

  /** No-op: see {@link subscribe}. */
  public async unsubscribe(): Promise<void> {
    // No-op: loopback delegates send() to the target; subscriptions are not relevant.
  }

  /**
   * Delegate readiness check to the target transport.
   * @returns `true` when the target transport is ready or has no `isReady` method.
   */
  public isReady(): boolean {
    return this.#target.isReady?.() !== false;
  }

  /**
   * Delegate broadcast results to the target transport if supported.
   * @param correlationId - Correlation ID of the originating broadcast.
   * @param results - Collected per-node broadcast responses.
   * @param error - Optional transport-level error for the broadcast.
   */
  public onBroadcastResults(
    correlationId: string,
    results: ReadonlyArray<{ nodeId: string; payload: unknown }>,
    error?: BusTransportError,
  ): void {
    this.#target.onBroadcastResults?.(correlationId, results, error);
  }
}

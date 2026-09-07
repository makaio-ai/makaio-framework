import { ConnectionLostError } from '@makaio/bus-core';
import { connectionClosedError } from './connection-error.js';
import type { WebSocketLike } from './types.js';

/** One adopted socket and its immutable termination outcome, independent of reconnect ownership. */
export class ClientSocketSession {
  private readonly termination = new AbortController();
  private ownedSocket: WebSocketLike | null;
  private readonly onClose: (event: unknown) => void;

  /**
   * Observe closure before connection callbacks can notify users or drain replies.
   * @param socket - Socket exclusively owned by this session.
   * @param name - Transport identity for connection-loss diagnostics.
   */
  public constructor(
    socket: WebSocketLike,
    private readonly name: string,
  ) {
    this.ownedSocket = socket;
    this.onClose = (event) => {
      const failure = connectionClosedError(event);
      this.end(failure.code === 'WS_POLICY_REJECTED' ? failure : new ConnectionLostError(name));
    };
    socket.addEventListener('close', this.onClose);
  }

  /**
   * Socket identity remains available until buffered inbound replies have drained.
   * @returns The retained socket, or null after its release.
   */
  public get socket(): WebSocketLike | null {
    return this.ownedSocket;
  }

  /**
   * Ending this session does not reject correlations that may still have buffered replies.
   * @returns The signal carrying this session's immutable termination outcome.
   */
  public get signal(): AbortSignal {
    return this.termination.signal;
  }

  /**
   * Recorded outcome, independent of whether the socket has finished its drain.
   * @returns The terminal failure, or undefined while this session remains active.
   */
  public get failure(): Error | undefined {
    return this.signal.reason instanceof Error ? this.signal.reason : undefined;
  }

  /**
   * Record exactly one outcome; later disconnect/cleanup cannot overwrite policy rejection.
   * @param failure - Classified failure or explicit owner cancellation.
   */
  public end(failure: Error): void {
    this.ownedSocket?.removeEventListener('close', this.onClose);
    this.termination.abort(failure);
  }

  /**
   * Release the socket after drain or explicit disposal, retaining its terminal outcome.
   * @param failure - Failure for a session not already ended by a close event.
   */
  public release(failure: Error = new ConnectionLostError(this.name)): void {
    this.end(failure);
    this.ownedSocket = null;
  }

  /**
   * Fence an outbound operation to this session before and after asynchronous encoding.
   * CLOSING has no trustworthy close code yet. Correlated sends observe that outcome
   * within their existing cancellation scope. Uncorrelated sends cannot wait for a
   * reply or deadline, so reject without inventing a retryable or policy outcome.
   * @param current - Currently adopted session.
   * @param signal - Existing request cancellation/timeout scope; absent for uncorrelated sends.
   * @returns The still-open socket belonging to this session.
   */
  public writable(current: ClientSocketSession | null, signal?: AbortSignal): WebSocketLike | Promise<never> {
    signal?.throwIfAborted();
    this.signal.throwIfAborted();
    if (current !== this || this.ownedSocket === null) throw new ConnectionLostError(this.name);
    const socket = this.ownedSocket;
    if (socket.readyState === 2 || socket.readyState === 3) {
      if (signal === undefined) throw new Error('WebSocket is closing; uncorrelated message was not sent');
      return observeUntilAborted(new Promise<never>(() => {}), AbortSignal.any([signal, this.signal]));
    }
    if (socket.readyState !== 1) throw new ConnectionLostError(this.name);
    return socket;
  }
}

/**
 * Stop observing an asynchronous operation on cancellation without leaking listeners
 * or unhandled late rejections. The underlying operation keeps its own resource owner.
 * @param operation - Already-started operation.
 * @param signal - Owning send or socket cancellation.
 * @returns Timely result, or the original cancellation reason.
 */
export async function observeUntilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = (): void => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

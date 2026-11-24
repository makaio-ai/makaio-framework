import type { BusSubscribeMessage, BusUnsubscribeMessage } from '@makaio/bus-core';
import type { ServerBoundaryAccess } from './server-boundary-access.js';
import type { TransportAuth, WebSocketLike } from './types.js';

const MAX_DEFERRED_PATTERNS = 1024;
// Allow hundreds of small handler registrations while bounding unprocessed wire data per socket.
export const MAX_QUEUED_SUBSCRIPTION_BYTES = 512 * 1024;

/** Pending patterns awaiting authorization, owned by one socket. */
export class DeferredSubscriptionReplay {
  private readonly pending = new Map<string, BusSubscribeMessage>();

  /** @param socket - The connection that advertised these patterns. */
  public constructor(private readonly socket: WebSocketLike) {}

  /**
   * Retain the pattern and its routing metadata without retaining the rest of the frame.
   * @param message - Original subscription advertisement.
   * @param patterns - Unavailable patterns with their advertised handler priorities.
   */
  public defer(message: BusSubscribeMessage, patterns: Record<string, number[]>): void {
    for (const [pattern, priorities] of Object.entries(patterns)) this.retain(message, pattern, priorities);
  }

  /**
   * @param message - Original subscription advertisement.
   * @param pattern - Unavailable pattern.
   * @param priorities - Advertised handler priorities.
   */
  private retain(message: BusSubscribeMessage, pattern: string, priorities: number[]): void {
    if (this.socket.readyState !== 1) return;
    if (!this.pending.has(pattern) && this.pending.size >= MAX_DEFERRED_PATTERNS) {
      this.clear();
      this.socket.close(1008, 'Too many deferred subscription patterns');
      return;
    }
    const filter = message.filters?.[pattern];
    this.pending.set(pattern, {
      type: 'subscribe',
      subjects: { [pattern]: priorities },
      deliveryClasses: { [pattern]: message.deliveryClasses?.[pattern] ?? 'first-hop-only' },
      ...(filter === undefined ? {} : { filters: { [pattern]: filter } }),
    });
  }

  /**
   * Forget patterns superseded by a newer advertisement or an unsubscribe.
   * @param subjects - Patterns updated by the peer.
   */
  public forget(subjects: Record<string, number[]>): void {
    for (const pattern of Object.keys(subjects)) this.pending.delete(pattern);
  }

  /** @returns Pending advertisements for one pass through the normal admission path. */
  public snapshot(): BusSubscribeMessage[] {
    return [...this.pending.values()];
  }

  /** Release retained advertisements when the socket closes. */
  public clear(): void {
    this.pending.clear();
  }
}

type SubscriptionMessage = BusSubscribeMessage | BusUnsubscribeMessage;

/**
 * Serialize live subscription updates and retries on the same connection.
 * @param socket - The connection owning the subscription state.
 * @param options - Policy, authentication, and diagnostic options.
 * @param route - Run a subscription through the normal routing path.
 * @param lifetime - Aborted on socket close.
 * @returns A function to enqueue live subscription updates.
 */
export function createSubscriptionQueue(
  socket: WebSocketLike,
  { access, auth, debug }: { access?: ServerBoundaryAccess; auth?: TransportAuth; debug: boolean },
  route: (message: SubscriptionMessage, replay?: DeferredSubscriptionReplay) => Promise<void>,
  lifetime?: AbortSignal,
): (message: SubscriptionMessage, frameBytes: number) => Promise<void> {
  let tail = Promise.resolve();
  let scheduledReplay: Promise<void> | undefined;
  let queuedBytes = 0;
  const replay = new DeferredSubscriptionReplay(socket);
  const isLive = (): boolean =>
    !lifetime?.aborted && socket.readyState === 1 && auth?.isSocketAuthenticated?.(socket) !== false;

  /**
   * Append work without letting a failed update block later updates.
   * @param apply - The next ordered update.
   * @returns The result of that update.
   */
  function enqueue(apply: () => Promise<void>): Promise<void> {
    const update = tail.then(apply);
    tail = update.catch(() => undefined);
    return update;
  }

  const stopWatching = access?.watchSubscriptionAvailability(() => {
    scheduledReplay ??= enqueue(async () => {
      scheduledReplay = undefined;
      for (const message of replay.snapshot()) {
        if (!isLive()) break;
        await route(message, replay);
      }
    }).catch((error: unknown) => {
      if (debug) console.error('[ServerTransport] Failed to replay subscription:', error);
    });
    return scheduledReplay;
  });
  lifetime?.addEventListener(
    'abort',
    () => {
      stopWatching?.();
      replay.clear();
    },
    { once: true },
  );

  return async (message, frameBytes) => {
    if (queuedBytes + frameBytes > MAX_QUEUED_SUBSCRIPTION_BYTES) {
      if (isLive()) socket.close(1008, 'Queued subscription frames exceed byte limit');
      return;
    }
    queuedBytes += frameBytes;
    try {
      await enqueue(async () => {
        if (isLive()) await route(message, stopWatching === undefined ? undefined : replay);
      });
    } finally {
      queuedBytes -= frameBytes;
    }
  };
}

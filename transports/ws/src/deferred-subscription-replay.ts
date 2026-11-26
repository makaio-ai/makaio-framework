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
   * Stage replacement of pending advertisements and return their restoration.
   * @param message - Subscription update being dispatched.
   * @param superseded - Patterns this update replaces or removes.
   * @param deferred - New patterns that still await admission.
   * @returns Restore the previous pending advertisements if dispatch fails.
   */
  public stage(
    message: SubscriptionMessage,
    superseded: Record<string, number[]>,
    deferred: Record<string, number[]>,
  ): () => void {
    const affected = new Set([...Object.keys(superseded), ...Object.keys(deferred)]);
    const previous = [...affected].map((pattern) => [pattern, this.pending.get(pattern)] as const);
    this.forget(superseded);
    if (message.type === 'subscribe') {
      for (const [pattern, priorities] of Object.entries(deferred)) this.retain(message, pattern, priorities);
    }
    return () => {
      if (this.socket.readyState !== 1) return;
      for (const [pattern, entry] of previous) {
        if (entry === undefined) this.pending.delete(pattern);
        else this.pending.set(pattern, entry);
      }
    };
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

/** Work retained while the socket waits for inbound routing. */
interface QueuedFrame {
  readonly charge: FrameCharge;
  readonly apply: () => Promise<void>;
  readonly result: PromiseWithResolvers<void>;
}

/** Both byte budgets apply to the same queue. */
interface FrameCharge {
  readonly bytes: number;
  readonly subscriptionBytes: number;
  readonly maxBytes?: number;
}

/**
 * Share one byte-bounded queue between live ordered frames and subscription retries.
 * @param socket - The connection owning the queue.
 * @param options - Policy, authentication, and diagnostic options.
 * @param replay - Pending advertisements owned by the client registry.
 * @param route - Run a replay through the normal subscription routing path.
 * @param lifetime - Aborted when the socket is detached.
 * @returns The socket's enqueue operation.
 */
export function createInboundQueue(
  socket: WebSocketLike,
  { access, auth, debug }: { access?: ServerBoundaryAccess; auth?: TransportAuth; debug: boolean },
  replay: DeferredSubscriptionReplay,
  route: (message: SubscriptionMessage, replay: DeferredSubscriptionReplay) => Promise<void>,
  lifetime?: AbortSignal,
) {
  const queue = new Set<QueuedFrame>();
  let draining = false;
  let queuedBytes = 0;
  let queuedSubscriptionBytes = 0;
  let scheduledReplay: Promise<void> | undefined;
  const isLive = (): boolean =>
    !lifetime?.aborted && socket.readyState === 1 && auth?.isSocketAuthenticated?.(socket) !== false;

  /** Drain frames in order, releasing each byte reservation at handoff. */
  async function drain(): Promise<void> {
    for (const frame of queue) {
      queue.delete(frame);
      try {
        if (isLive()) await frame.apply();
        frame.result.resolve();
      } catch (error) {
        frame.result.reject(error);
      } finally {
        release(frame);
      }
    }
    draining = false;
  }

  /**
   * Return the byte budget of a handed-off or discarded frame.
   * @param frame - Frame leaving the queue.
   */
  function release(frame: QueuedFrame): void {
    queuedBytes -= frame.charge.bytes;
    queuedSubscriptionBytes -= frame.charge.subscriptionBytes;
  }

  /**
   * Enqueue work within the socket's subscription and exchange byte budgets.
   * @param apply - Work ending when the frame has been handed off.
   * @param charge - Wire bytes and the optional protected exchange limit.
   * @param overflow - End the connection when the budget is exhausted.
   * @returns Settlement of the queued work.
   */
  function enqueue(apply: () => Promise<void>, charge: FrameCharge, overflow?: () => void): Promise<void> {
    if (
      queuedSubscriptionBytes + charge.subscriptionBytes > MAX_QUEUED_SUBSCRIPTION_BYTES ||
      (charge.maxBytes !== undefined && queuedBytes + charge.bytes > charge.maxBytes)
    ) {
      if (isLive()) overflow?.();
      return Promise.resolve();
    }
    const result = Promise.withResolvers<void>();
    queuedBytes += charge.bytes;
    queuedSubscriptionBytes += charge.subscriptionBytes;
    queue.add({ charge, apply, result });
    if (!draining) {
      draining = true;
      queueMicrotask(() => void drain());
    }
    return result.promise;
  }

  const stopWatching = access?.watchSubscriptionAvailability(() => {
    scheduledReplay ??= enqueue(
      async () => {
        scheduledReplay = undefined;
        for (const message of replay.snapshot()) {
          if (!isLive()) break;
          await route(message, replay);
        }
      },
      { bytes: 0, subscriptionBytes: 0 },
    ).catch((error: unknown) => {
      if (debug) console.error('[ServerTransport] Failed to replay subscription:', error);
    });
    return scheduledReplay;
  });
  lifetime?.addEventListener(
    'abort',
    () => {
      stopWatching?.();
      replay.clear();
      for (const frame of queue) {
        release(frame);
        frame.result.resolve();
      }
      queue.clear();
    },
    { once: true },
  );

  return { enqueue, replay: stopWatching === undefined ? undefined : replay };
}

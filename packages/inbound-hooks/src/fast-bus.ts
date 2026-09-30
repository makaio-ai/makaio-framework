import { emitInboundHookReceived } from './emit.js';
import { connectFastHookBus } from './fast-connection.js';
import { normalizeTimeoutMs, startDeadline } from './fast-hook-timing.js';
import type { RawInboundHookPayload } from './schemas.js';

/**
 * Options for the fast single-shot hook bus connection.
 */
export interface FastHookBusOptions {
  /** WebSocket URL of the bus server. Defaults to `ws://127.0.0.1:6252/bus`. */
  readonly busUrl?: string;
  /**
   * Milliseconds allowed for connect and emit before giving up.
   * Defaults to `250`.
   */
  readonly timeoutMs?: number;
  /**
   * Milliseconds to wait before giving up.
   * @deprecated Use `timeoutMs`; the timeout now applies to the whole delivery path.
   */
  readonly connectTimeoutMs?: number;
  /** HMAC secret for bus authentication. Falls back to `MAKAIO_BUS_SECRET`. */
  readonly secret?: string;
  /** Transport debug logging (written to stderr; stdout is the hook response channel); falls back to MAKAIO_DEBUG === 'true'. */
  readonly debug?: boolean;
}

/**
 * Connect to the local bus, emit a raw inbound hook payload, and disconnect.
 *
 * Optimized for fast-exit hook processes: uses a single short-lived WebSocket
 * connection with a tight whole-operation timeout. All failures are swallowed
 * so the calling hook process exits cleanly regardless of bus availability.
 * @param source - Stable source identifier (e.g., `'git'`, `'claude-code'`).
 * @param payload - Raw hook payload to emit.
 * @param options - Bus connection options.
 */
export async function emitInboundHookReceivedFast(
  source: string,
  payload: RawInboundHookPayload,
  options: FastHookBusOptions = {},
): Promise<void> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? options.connectTimeoutMs);
  const remainingMs = startDeadline(timeoutMs);
  const connection = await connectFastHookBus({
    name: `hook-${source}`,
    busUrl: options.busUrl,
    secret: options.secret,
    timeoutMs,
    debug: options.debug,
  });
  if (!connection) {
    return;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const delivery = emitInboundHookReceived(connection.bus, source, payload, { failOpen: true });
  void delivery.catch(() => undefined);
  try {
    await Promise.race([
      delivery,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('hook bus delivery timeout'));
        }, remainingMs());
      }),
    ]);
  } catch {
    return;
  } finally {
    clearTimeout(timeoutId);
    connection.dispose();
  }
}

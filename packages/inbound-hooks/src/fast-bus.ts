import { createBusInstance } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { emitInboundHookReceived } from './emit.js';
import type { RawInboundHookPayload } from './schemas.js';

const DEFAULT_BUS_URL = 'ws://127.0.0.1:6252/bus';
const DEFAULT_TIMEOUT_MS = 250;

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
  const url = options.busUrl?.trim() || process.env['MAKAIO_BUS_URL']?.trim() || DEFAULT_BUS_URL;
  const secret = options.secret ?? process.env['MAKAIO_BUS_SECRET'];
  const auth = secret && secret.trim().length > 0 ? new HmacAuth({ secret: secret.trim() }) : undefined;
  const transport = new WebSocketClientTransport({
    url,
    name: `hook-${source}`,
    autoReconnect: false,
    auth,
    debug: process.env['MAKAIO_DEBUG'] === 'true',
  });
  const bus = createBusInstance({ transports: [transport] });
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? options.connectTimeoutMs);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const delivery = (async () => {
    await bus.connect();
    if (timedOut) {
      return;
    }
    await emitInboundHookReceived(bus, source, payload, { failOpen: true });
  })();
  void delivery.catch(() => undefined);
  try {
    await Promise.race([
      delivery,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error('hook bus delivery timeout'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    return;
  } finally {
    clearTimeout(timeoutId);
    disconnectBestEffort(() => bus.disconnect());
  }
}

/**
 * Normalize user-provided timeout options to the default fast-path budget.
 * @param value - User-provided timeout in milliseconds.
 * @returns A non-negative timeout in milliseconds.
 */
function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * Start bus disconnect without letting cleanup extend the hook fast path.
 * @param disconnect - Disconnect callback for the bus instance.
 */
function disconnectBestEffort(disconnect: () => void): void {
  try {
    disconnect();
  } catch {
    // Best-effort cleanup must not affect native hook execution.
  }
}

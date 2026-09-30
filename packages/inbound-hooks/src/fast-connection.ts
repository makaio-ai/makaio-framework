import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { disconnectBestEffort, normalizeTimeoutMs } from './fast-hook-timing.js';

/** Bus URL used when neither an option nor `MAKAIO_BUS_URL` is set. */
export const DEFAULT_FAST_HOOK_BUS_URL = 'ws://127.0.0.1:6252/bus';

/**
 * Options for {@link connectFastHookBus}.
 */
export interface ConnectFastHookBusOptions {
  /** Transport name, e.g. `hook-git`, `client-hook-claude-code`. */
  readonly name: string;
  /** WebSocket URL; falls back to MAKAIO_BUS_URL, then ws://127.0.0.1:6252/bus. */
  readonly busUrl?: string;
  /** HMAC secret; falls back to MAKAIO_BUS_SECRET. Blank means no auth. */
  readonly secret?: string;
  /** Deadline for the connect step in ms (non-negative finite, else 250). */
  readonly timeoutMs?: number;
  /** Transport debug logging, gated here (written to stderr; stdout is the hook response channel; bus diagnostics always go to stderr); falls back to MAKAIO_DEBUG === 'true'. */
  readonly debug?: boolean;
}

/**
 * A connected short-lived hook bus.
 */
export interface FastHookBusConnection {
  /** The connected bus instance. */
  readonly bus: IMakaioBus;
  /** Best-effort disconnect; never throws. */
  dispose(): void;
}

/**
 * Connect a short-lived bus (autoReconnect off) within the deadline.
 *
 * Never rejects: any connect failure or timeout disposes the bus and resolves `null`.
 * @param options - Connection options.
 * @returns The connection, or `null` when the bus could not be reached in time.
 */
export async function connectFastHookBus(options: ConnectFastHookBusOptions): Promise<FastHookBusConnection | null> {
  let bus: IMakaioBus;
  try {
    const url = options.busUrl?.trim() || process.env['MAKAIO_BUS_URL']?.trim() || DEFAULT_FAST_HOOK_BUS_URL;
    const secret = (options.secret ?? process.env['MAKAIO_BUS_SECRET'])?.trim();
    const auth = secret ? new HmacAuth({ secret }) : undefined;
    // connectTimeoutMs (30 s default) is intentionally not set: the outer deadline plus
    // bus.disconnect() aborts the in-flight attempt and clears the transport's timer, and
    // connectTimeoutMs would not cover the peer-sync readiness wait that bus.connect() includes.
    // stdout is the hook response channel; transport and bus diagnostics must not land there.
    const debugLog = (message: string): void => {
      process.stderr.write(`${message}\n`);
    };
    const transport = new WebSocketClientTransport({
      url,
      name: options.name,
      autoReconnect: false,
      auth,
      debug: options.debug ?? process.env['MAKAIO_DEBUG'] === 'true',
      debugLog,
    });
    bus = createBusInstance({ transports: [transport], debugLog });
  } catch {
    return null;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const connecting = bus.connect();
    void connecting.catch(() => undefined);
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('hook bus connect timeout'));
        }, normalizeTimeoutMs(options.timeoutMs));
      }),
    ]);
    return { bus, dispose: () => disconnectBestEffort(() => bus.disconnect()) };
  } catch {
    disconnectBestEffort(() => bus.disconnect());
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

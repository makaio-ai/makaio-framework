import { createBusInstance } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { HostSubjects } from '@makaio/contracts';
import { normalizeBusSecret } from '@makaio/utils';
import type { HealthResult } from './health-probe.js';

const CONNECT_TIMEOUT_MS = 3_000;

/**
 * Connect to a running instance's bus and request focus.
 * @param port - The port where the running instance serves.
 * @param health - Health probe result (determines auth requirements).
 * @returns True if the existing instance was focused; false when the focus
 * request cannot complete.
 */
export async function connectAndFocus(port: number, health: HealthResult): Promise<boolean> {
  const url = `ws://127.0.0.1:${port}/bus`;
  let connectTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let bus: ReturnType<typeof createBusInstance> | undefined;

  try {
    let auth: HmacAuth | undefined;
    if (health.auth) {
      const secret = normalizeBusSecret(process.env['MAKAIO_BUS_SECRET']);
      if (!secret) return false;
      auth = new HmacAuth({ secret });
    }

    const transport = new WebSocketClientTransport({
      url,
      name: 'second-instance',
      autoReconnect: false,
      auth,
    });
    bus = createBusInstance({ transports: [transport] });

    await Promise.race([
      bus.connect(),
      new Promise<never>((_, reject) => {
        connectTimeoutId = setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS);
      }),
    ]);
    const result = await bus.request(HostSubjects.app.focus, {});
    return result.focused;
  } catch {
    // Second-instance handoff is best-effort. Returning false lets callers
    // continue normal startup instead of surfacing transient bus failures.
    return false;
  } finally {
    clearTimeout(connectTimeoutId);
    bus?.disconnect();
  }
}

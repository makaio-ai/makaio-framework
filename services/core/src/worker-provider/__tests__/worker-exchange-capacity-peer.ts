import { once } from 'node:events';
import { WebSocket } from 'ws';
import type { ExchangeMessage } from './worker-exchange-process-types.js';

/**
 * Exercise capacity over TLS while the first connection remains unconfirmed.
 * @param connect - Connect the same peer process to the real exchange listener.
 * @param report - Publish wire evidence before resuming the first presentation.
 * @returns The original, still open socket.
 */
export async function waitForCapacityRefusal(
  connect: () => WebSocket,
  report: (message: ExchangeMessage) => void,
): Promise<WebSocket> {
  const occupied = connect();
  const closed = new AbortController();
  occupied.once('close', () => closed.abort());
  await once(occupied, 'open', { signal: closed.signal });
  try {
    const startedAt = performance.now();
    const status = await readUpgradeRefusal(connect());
    const present = once(process, 'message', { signal: closed.signal });
    report({ kind: 'capacity-refused', status, latencyMs: performance.now() - startedAt });
    const [command] = await present;
    if (command !== 'present' || occupied.readyState !== WebSocket.OPEN) throw new Error('Occupied exchange was lost');
    return occupied;
  } catch (error) {
    occupied.terminate();
    throw error;
  }
}

/**
 * Read the actual HTTP upgrade status from the overloaded listener.
 * @param contender - Client probing the full listener.
 * @returns HTTP status of the refused upgrade.
 */
function readUpgradeRefusal(contender: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    contender.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    contender.once('open', () => {
      contender.terminate();
      reject(new Error('Over-capacity upgrade was accepted'));
    });
    contender.once('error', reject);
    contender.once('close', () => reject(new Error('Capacity probe closed before its upgrade response')));
  });
}

/**
 * Wait for the native listener to evict a peer that never sends its first frame.
 * @param connect - Connect the same peer process to the real exchange listener.
 * @param report - Publish the native close status before attempting the next connection.
 */
export async function waitForSilentClose(
  connect: () => WebSocket,
  report: (message: ExchangeMessage) => void,
): Promise<void> {
  const [code] = await once(connect(), 'close');
  if (typeof code !== 'number') throw new Error('Missing native close status');
  report({ kind: 'silent-closed', code });
}

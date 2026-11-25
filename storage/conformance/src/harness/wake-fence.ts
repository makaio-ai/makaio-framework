import type { HostDatabase } from '@makaio/contracts';
import { type DatabaseSignals, markTransactionWakeTopic } from '@makaio/storage-drizzle';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Wait for earlier notifications on the host's existing listener.
 * @param host - Host database backed by the observed database handle.
 * @param signals - Signal capability from that same handle.
 */
export async function waitForWakeFence(host: HostDatabase, signals: DatabaseSignals): Promise<void> {
  if (signals.kind !== 'database-notify') return;

  // Listen directly so local delivery cannot resolve the fence.
  // PostgreSQL delivers notifications in commit order.
  const fence = randomUUID();
  const delivered = Promise.withResolvers<void>();
  const stop = signals.subscribe((event) => {
    if (event.kind === 'topic' && event.topic === fence) delivered.resolve();
  });
  const abort = new AbortController();
  try {
    await signals.ready();
    await host.transaction(async (tx) => markTransactionWakeTopic(tx, fence));
    await Promise.race([
      delivered.promise,
      delay(2000, undefined, { signal: abort.signal }).then(() => {
        throw new Error('Postgres notification fence was not delivered.');
      }),
    ]);
  } finally {
    abort.abort();
    stop();
  }
}

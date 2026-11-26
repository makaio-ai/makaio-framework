import { DEFAULT_READINESS_TIMEOUT_MS } from '@makaio/bus-core';
import type { HostDatabase } from '@makaio/contracts';
import { DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS } from '../../../../../transports/ws/src/auth/auth-deadline.js';

/**
 * Control only the first exchange input timer in this independent host process.
 * The test advances through the entire existing window after the timer is armed.
 * @param armed - Notify the supervisor that the real authentication path is waiting.
 */
export function controlFirstExchangeInputTimeout(armed: () => void): void {
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => {
    if (milliseconds !== DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS) return timeout(milliseconds);
    AbortSignal.timeout = timeout;
    const elapsed = new AbortController();
    const advance = (command: unknown): void => {
      if (command !== 'expire-input') return;
      process.off('message', advance);
      elapsed.abort(new DOMException('Exchange input window elapsed', 'TimeoutError'));
    };
    process.on('message', advance);
    armed();
    return elapsed.signal;
  };
}

/** Advance the test host's monotonic clock across the refusal release window. */
export function advanceRefusalClock(): void {
  const timeout = AbortSignal.timeout;
  const now = performance.now.bind(performance);
  AbortSignal.timeout = (milliseconds) => {
    if (milliseconds === DEFAULT_READINESS_TIMEOUT_MS) {
      // The release point was set just before the setup signal was created.
      AbortSignal.timeout = timeout;
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: () => now() + milliseconds,
      });
    }
    return timeout(milliseconds);
  };
}

/**
 * Advance the wall clock inside the next real transaction.
 * @param database - Test host's database facade.
 * @param deadline - Absolute deadline for this exchange.
 * @param phase - Advance before the callback or before returning its result for commit.
 * @returns Restores the original wall clock and transaction entry point.
 */
export function expireInTransaction(database: HostDatabase, deadline: number, phase: 'start' | 'finish'): () => void {
  const now = Date.now;
  const transaction = database.transaction;
  const transact = transaction.bind(database);
  database.transaction = (work, options) =>
    transact(async (tx) => {
      if (phase === 'start') Date.now = () => deadline;
      const result = await work(tx);
      if (phase === 'finish') Date.now = () => deadline;
      return result;
    }, options);
  return () => {
    Date.now = now;
    database.transaction = transaction;
  };
}

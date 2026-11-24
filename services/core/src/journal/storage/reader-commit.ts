import type { HostTransaction, ReaderOutcome } from '@makaio/contracts';

type ReaderCommit = NonNullable<Extract<ReaderOutcome, { state: 'done' }>['commit']>;

/** Durable retry reason shared by every path that retires an expired reader claim. */
export const READER_DEADLINE_REASON = 'reader-deadline';

/** Roll back the effect transaction when its commit callback outlives the claim. */
export class ReaderCommitDeadlineExceeded extends Error {
  public readonly code = READER_DEADLINE_REASON;
}

/**
 * Run an extension effect within the remainder of its claim.
 * The caller owns the transaction and rolls it back on rejection.
 * @param commit - Extension effect to book with reader progress.
 * @param tx - Guarded transaction supplied to the effect.
 * @param expiresAt - Deadline in local epoch milliseconds.
 * @returns The outcome of the effect, if it finishes in time.
 */
export async function runReaderCommit(
  commit: ReaderCommit,
  tx: HostTransaction,
  expiresAt: number,
): ReturnType<ReaderCommit> {
  const failure = new ReaderCommitDeadlineExceeded('The reader commit exceeded its claim deadline.');
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) throw failure;

  const controller = new AbortController();
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(failure), remaining);

  try {
    const result = await Promise.race([timeout.promise, commit(tx, controller.signal)]);
    if (Date.now() >= expiresAt) throw failure;
    return result;
  } catch (error) {
    if (error !== failure && Date.now() < expiresAt) throw error;
    controller.abort(failure);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounding helper for awaits that would otherwise have no end.
 * @packageDocumentation
 */

/**
 * Race a promise against a timeout, clearing the timer when either settles.
 *
 * Exists so an adapter that declares a budget can actually honour it: an
 * unbounded await on a provider handshake is indistinguishable from a hang, and
 * a caller waiting behind it inherits that hang. The timer is always cleared, so
 * bounding a promise never keeps the event loop alive past its settlement.
 *
 * The bound applies to the *wait*, not to the work. A rejected race leaves the
 * underlying operation running; callers that own a resource behind the promise
 * are responsible for releasing it.
 * @param promise - Promise to bound.
 * @param ms - Milliseconds to wait before rejecting.
 * @param message - Error message used when the bound expires.
 * @returns The promise's resolved value.
 * @throws Error with `message` when the bound expires first.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

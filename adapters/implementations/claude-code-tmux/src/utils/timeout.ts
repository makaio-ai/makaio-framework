/**
 * Timeout helpers for Claude Code tmux async lifecycle waits.
 * @packageDocumentation
 */

/**
 * Race a promise against a timeout, clearing the timer when the promise settles.
 *
 * Uses `try/finally` to guarantee the timer handle is always cleared regardless
 * of whether the promise resolves, rejects, or the timeout fires first.
 * @param promise - Promise to race against the timeout.
 * @param ms - Timeout in milliseconds.
 * @param message - Error message when the timeout fires.
 * @returns The resolved value of `promise`, or rejects with a timeout error.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

import { abortableWait } from '@makaio/utils';

/** Default window for an authentication challenge and its response. */
export const DEFAULT_AUTH_CHALLENGE_TIMEOUT_MS = 5_000;

/**
 * Release business refusals on the same schedule and cancel the timer on close.
 * @param releaseAt - Deadline on the monotonic clock.
 * @param signal - Lifetime of the socket.
 */
export async function waitForRefusalRelease(releaseAt: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, releaseAt - performance.now()));
    });
    await abortableWait(wait, signal);
  } finally {
    clearTimeout(timer);
  }
}

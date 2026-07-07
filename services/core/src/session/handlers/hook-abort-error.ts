import { HookAbortError } from '@makaio/hooks';

/**
 * Detects hook-driven cancellation across direct and bus-wrapped errors.
 *
 * Bus dispatch may wrap the original error as `cause`, so an `instanceof`
 * check on the thrown value alone would miss hook aborts raised behind a
 * request boundary.
 * @param error - Error thrown while dispatching to an agent
 * @returns The hook abort error when present
 */
export function getHookAbortError(error: unknown): HookAbortError | undefined {
  if (error instanceof HookAbortError) {
    return error;
  }
  if (error instanceof Error && error.cause instanceof HookAbortError) {
    return error.cause;
  }
  return undefined;
}

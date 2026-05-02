/**
 * StrictMode-safe generation guard for async effects.
 *
 * Provides a shared `runIdRef` and a `captureGeneration` factory that
 * increments the ref and returns an `isCurrent` predicate bound to the
 * captured value. Any async work that holds the predicate can cheaply
 * detect whether it was superseded by a later render, unmount/remount, or
 * event-driven refetch.
 * @packageDocumentation
 */

import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Creates a StrictMode-safe guard for async effects.
 *
 * Returns a ref whose `.current` is incremented on each call to
 * `captureGeneration`, and a stable `captureGeneration` function that returns
 * an `isCurrent` predicate for the captured value. Use in `useEffect` to bail
 * out of stale async work after unmount/remount or when dependencies change.
 *
 * Typical usage inside a `useEffect`:
 * ```typescript
 * const [, captureGeneration] = useEffectGuard();
 *
 * useEffect(() => {
 * const isCurrent = captureGeneration();
 * void asyncWork().then((result) => {
 * if (!isCurrent()) return;
 * setState(result);
 * });
 * return () => { captureGeneration(); }; // invalidate on cleanup
 * }, [deps]);
 * ```
 *
 * When the same `runIdRef` must be shared across the effect and its
 * event-handler closures (so each handler bumps the same counter), request
 * the tuple's first element:
 * ```typescript
 * const [runIdRef, captureGeneration] = useEffectGuard();
 * ```
 * @returns Tuple of `[runIdRef, captureGeneration]` where `captureGeneration`
 *   increments `runIdRef.current` and returns a predicate that returns `true`
 *   only while the captured generation is still the latest.
 */
export function useEffectGuard(): [MutableRefObject<number>, () => () => boolean] {
  const runIdRef = useRef(0);

  const captureGeneration = useCallback((): (() => boolean) => {
    const generation = ++runIdRef.current;
    return (): boolean => runIdRef.current === generation;
  }, []);

  return [runIdRef, captureGeneration];
}

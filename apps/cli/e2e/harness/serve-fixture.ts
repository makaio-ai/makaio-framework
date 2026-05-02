/**
 * Shared E2E test fixture for managing a spawned CLI serve process.
 *
 * Installs an `afterEach` hook that kills the process and clears the ref.
 * Tests assign the returned ref after spawning via {@link startCliServe}.
 */
import { afterEach } from 'vitest';
import type { ServeProcess } from './spawn-serve.js';

/**
 * Mutable ref to the current serve process.
 * Assign after {@link startCliServe}; the cleanup function handles teardown.
 */
export interface ServeRef {
  current: ServeProcess | null;
}

/**
 * Install an `afterEach` hook that kills the serve process and clears the ref.
 * @returns Mutable ref to assign after spawning the serve process.
 */
export function useServeFixture(): ServeRef {
  const ref: ServeRef = { current: null };
  afterEach(async () => {
    const proc = ref.current;
    if (!proc) return;
    try {
      await proc.kill();
    } finally {
      if (ref.current === proc) ref.current = null;
    }
  });
  return ref;
}

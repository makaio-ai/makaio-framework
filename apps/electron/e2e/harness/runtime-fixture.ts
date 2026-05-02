/**
 * Shared E2E test fixture for managing a spawned headless Electron runtime
 * process.
 *
 * Installs an `afterEach` hook that kills the process and clears the ref.
 * Tests assign the returned ref after spawning via
 * {@link startElectronRuntime}.
 */
import { afterEach } from 'vitest';
import type { RuntimeProcess } from './spawn-runtime.js';

/**
 * Mutable ref to the current runtime process.
 * Assign after {@link startElectronRuntime}; the cleanup function handles teardown.
 */
export interface RuntimeRef {
  current: RuntimeProcess | null;
}

/**
 * Install an `afterEach` hook that kills the runtime process and clears the ref.
 * @returns Mutable ref to assign after spawning the runtime process.
 */
export function useRuntimeFixture(): RuntimeRef {
  const ref: RuntimeRef = { current: null };
  afterEach(async () => {
    const proc = ref.current;
    if (!proc) return;
    // Defensive: proc.kill() currently always resolves, but try/finally
    // ensures ref cleanup even if the contract changes.
    try {
      await proc.kill();
    } finally {
      if (ref.current === proc) ref.current = null;
    }
  });
  return ref;
}

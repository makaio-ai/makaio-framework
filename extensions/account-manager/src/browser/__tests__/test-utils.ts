/**
 * Shared test utilities for analytics widget tests.
 *
 * Provides helpers that must behave consistently across the analytics-heatmap,
 * analytics-history, and analytics-distribution widget test suites.
 */

import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { UiContextSnapshot } from '@makaio/contracts';
import { DEBOUNCE_MS } from '../data/use-account-history.js';

/** Minimal valid host UI context for direct widget component renders. */
export const TEST_UI_CONTEXT = {
  level: 'root',
  values: {},
} satisfies UiContextSnapshot;

/**
 * Advances fake timers past the {@link DEBOUNCE_MS} debounce and flushes microtasks.
 * Shared between analytics widget tests that consume debounced bus RPCs.
 *
 * Microtask loop is intentional — `waitFor` from `@testing-library/react`
 * hangs indefinitely under `vi.useFakeTimers()` because it polls via
 * `setInterval`, which the fake-timer hijacks. The explicit `for` loop drains
 * the bus's async chain deterministically.
 * @returns Promise that resolves once the debounce and microtask chain are drained.
 */
export async function flushDebounce(): Promise<void> {
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
  await flushMicrotasks();
}

/**
 * Flush repeated promise turns used by the bus/request test harness.
 *
 * `waitFor` is not reliable under fake timers because it polls via
 * `setInterval`; this helper drains the async chain deterministically instead.
 * @param turns - Number of microtask turns to drain.
 * @returns Promise that resolves after the requested turns complete.
 */
export async function flushMicrotasks(turns = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < turns; i++) {
      await Promise.resolve();
    }
  });
}

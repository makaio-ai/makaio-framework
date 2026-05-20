// @vitest-environment jsdom
/**
 * Tests for AnalyticsContext and useAnalyticsContext.
 *
 * Verifies:
 * - useAnalyticsContext throws during render when called outside a provider.
 * - useAnalyticsContext returns the correct filter value when inside a provider.
 */

import { createElement, type ReactNode } from 'react';
import { render, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnalyticsContext, useAnalyticsContext, type AnalyticsFilter } from '../analytics-context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILTER: AnalyticsFilter = {
  clientId: 'claude-code',
  accountId: 'acc-1',
  from: 1_000_000,
  to: 2_000_000,
  range: '7d',
};

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

/**
 * A component that calls useAnalyticsContext. Used to verify the throw.
 * @returns null.
 */
function ConsumerComponent(): null {
  useAnalyticsContext();
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAnalyticsContext', () => {
  it('throws during render when called outside a provider', () => {
    // React swallows the thrown error into an error boundary; we verify via
    // the raw render call which should propagate the throw synchronously.
    expect(() => render(createElement(ConsumerComponent))).toThrow('AnalyticsContext.Provider');
  });

  it('returns the filter value when inside a provider', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(AnalyticsContext.Provider, { value: FILTER }, children);

    const { result } = renderHook(() => useAnalyticsContext(), { wrapper });

    expect(result.current.clientId).toBe('claude-code');
    expect(result.current.accountId).toBe('acc-1');
    expect(result.current.from).toBe(1_000_000);
    expect(result.current.to).toBe(2_000_000);
    expect(result.current.range).toBe('7d');
  });
});

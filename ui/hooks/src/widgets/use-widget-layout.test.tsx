// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createBusInstance } from '@makaio/bus-core';
import { PreferencesSubjects, type PreferenceKey } from '@makaio/services-core/preferences';
import type { ReactNode } from 'react';
import { BusProvider } from '../bus/bus-provider.js';
import { useWidgetLayout } from './use-widget-layout.js';

const TEST_PREFERENCE_KEY: PreferenceKey = {
  scope: 'global',
};

/**
 * Render the hook with a local bus serving the stored preference.
 * @param value - Stored preference value returned to the hook.
 * @returns The rendered hook and its controls.
 */
function renderLayout(value: unknown) {
  const bus = createBusInstance();
  bus.on(PreferencesSubjects.get, (ctx) => ctx.setResult({ value }));
  return renderHook(() => useWidgetLayout(TEST_PREFERENCE_KEY), {
    wrapper: ({ children }: { children: ReactNode }) => <BusProvider bus={bus}>{children}</BusProvider>,
  });
}

describe('useWidgetLayout', () => {
  it('returns null for malformed placement entries instead of accepting any placements array', async () => {
    const { result } = renderLayout({
      version: 1,
      placements: [{ instanceId: 'widget-1' }],
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.layout).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('accepts a fully valid widget layout payload', async () => {
    const { result } = renderLayout({
      version: 1,
      placements: [
        {
          instanceId: 'widget-1',
          widgetId: 'git-status',
          col: 0,
          row: 0,
          size: 'medium',
          w: 2,
          h: 1,
          config: { compact: true },
        },
      ],
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.layout).toEqual({
      version: 1,
      placements: [
        {
          instanceId: 'widget-1',
          widgetId: 'git-status',
          col: 0,
          row: 0,
          size: 'medium',
          w: 2,
          h: 1,
          config: { compact: true },
        },
      ],
    });
  });
});

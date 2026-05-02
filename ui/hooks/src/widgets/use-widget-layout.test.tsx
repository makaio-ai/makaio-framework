// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { PreferenceKey } from '@makaio/services-core/preferences';
import { useWidgetLayout } from './use-widget-layout.js';

const mockBus = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../bus/bus-provider.js', () => ({
  useBus: () => mockBus,
}));

const TEST_PREFERENCE_KEY: PreferenceKey = {
  scope: 'global',
};

describe('useWidgetLayout', () => {
  beforeEach(() => {
    mockBus.request.mockReset();
  });

  it('returns null for malformed placement entries instead of accepting any placements array', async () => {
    mockBus.request.mockResolvedValue({
      value: {
        version: 1,
        placements: [{ instanceId: 'widget-1' }],
      },
    });

    const { result } = renderHook(() => useWidgetLayout(TEST_PREFERENCE_KEY));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.layout).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('accepts a fully valid widget layout payload', async () => {
    mockBus.request.mockResolvedValue({
      value: {
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
      },
    });

    const { result } = renderHook(() => useWidgetLayout(TEST_PREFERENCE_KEY));

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

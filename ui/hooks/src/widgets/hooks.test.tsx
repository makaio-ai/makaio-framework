// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWidgetConfig } from './hooks.js';

const mockBus = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../bus/bus-provider.js', () => ({
  useBus: () => mockBus,
}));

describe('useWidgetConfig', () => {
  beforeEach(() => {
    mockBus.request.mockReset();
    mockBus.request.mockResolvedValue({ value: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves structured default config values when resetting local state', async () => {
    const defaultConfig = {
      createdAt: new Date('2026-04-17T00:00:00.000Z'),
      label: 'Widget',
    };

    const { result } = renderHook(() =>
      useWidgetConfig({
        defaultConfig,
        context: { scope: 'global' },
        paneId: 'pane-1',
        surface: 'ui',
        widgetId: 'widget-1',
      }),
    );

    await waitFor(() => {
      expect(result.current.config.createdAt).toBeInstanceOf(Date);
    });

    expect(result.current.config.createdAt).toEqual(defaultConfig.createdAt);
  });
});

/* @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { widgetRegistry, type WidgetDefinition } from '@makaio/ui-kernel';
import { useTrayLayout } from './use-tray-layout.js';

declare module '@makaio/contracts' {
  interface UiScopeMap {
    tray: true;
  }
}

/** Mirrors `frameworkStatusWidgetDefinition.id` from ui-views. */
const frameworkStatusWidgetDefinition: WidgetDefinition = {
  component: () => null,
  defaultSize: 'small',
  description: 'Shows the current runtime connection status.',
  id: 'framework-status',
  name: 'Status',
  scope: ['tray'],
  supportedSizes: ['small'],
  trayDefaultSize: 'small',
};

/** Mirrors `frameworkOpenDashboardWidgetDefinition.id` from ui-views. */
const frameworkOpenDashboardWidgetDefinition: WidgetDefinition = {
  allowMultiple: false,
  component: () => null,
  defaultSize: 'small',
  description: 'Opens the main Makaio dashboard window.',
  id: 'framework-open-dashboard',
  name: 'Open Dashboard',
  scope: ['tray'],
  supportedSizes: ['small'],
};

const FRAMEWORK_TRAY_LOCKED_WIDGET_IDS = [
  frameworkStatusWidgetDefinition.id,
  frameworkOpenDashboardWidgetDefinition.id,
] as const;

/**
 * Creates a minimal tray-scoped widget definition for layout tests.
 * @param id - Widget identifier to register.
 * @param defaultSize - Default widget size to expose in the registry.
 * @returns Tray widget definition fixture for `widgetRegistry`.
 */
function makeTrayWidget(id: string, defaultSize: WidgetDefinition['defaultSize'] = 'small'): WidgetDefinition {
  return {
    component: () => null,
    defaultSize,
    id,
    name: id,
    scope: 'tray',
    supportedSizes: [defaultSize],
  };
}

describe('useTrayLayout', () => {
  afterEach(() => {
    widgetRegistry.clear();
  });

  it('places locked widgets before non-locked widgets', () => {
    widgetRegistry.register(makeTrayWidget('widget-a'));
    widgetRegistry.register(makeTrayWidget('widget-b'));
    widgetRegistry.register(makeTrayWidget('locked-1'));

    const { result } = renderHook(() => useTrayLayout(['locked-1']));
    const placements = result.current.placements;

    expect(placements[0].widgetId).toBe('locked-1');
    expect(placements[0].locked).toBe(true);
    expect(placements.find((placement) => placement.widgetId === 'widget-a')?.locked).toBeUndefined();
    expect(placements.find((placement) => placement.widgetId === 'widget-b')?.locked).toBeUndefined();
  });

  it('preserves the order of lockedWidgetIds', () => {
    widgetRegistry.register(makeTrayWidget('lock-z'));
    widgetRegistry.register(makeTrayWidget('lock-a'));
    widgetRegistry.register(makeTrayWidget('lock-m'));

    const { result } = renderHook(() => useTrayLayout(['lock-z', 'lock-a', 'lock-m']));
    const placements = result.current.placements;

    expect(placements[0].widgetId).toBe('lock-z');
    expect(placements[1].widgetId).toBe('lock-a');
    expect(placements[2].widgetId).toBe('lock-m');
  });

  it('skips missing locked widgets', () => {
    widgetRegistry.register(makeTrayWidget('registered'));

    const { result } = renderHook(() => useTrayLayout(['ghost-widget', 'registered']));

    expect(result.current.placements).toHaveLength(1);
    expect(result.current.placements[0].widgetId).toBe('registered');
  });

  it('keeps non-locked widgets in registration order after locked widgets', () => {
    widgetRegistry.register(makeTrayWidget('first'));
    widgetRegistry.register(makeTrayWidget('second'));
    widgetRegistry.register(makeTrayWidget('locked'));

    const { result } = renderHook(() => useTrayLayout(['locked']));

    expect(result.current.placements.map((placement) => placement.widgetId)).toEqual(['locked', 'first', 'second']);
  });

  it('maps tray sizes to full-width tray placements', () => {
    widgetRegistry.register(makeTrayWidget('sm', 'small'));
    widgetRegistry.register(makeTrayWidget('md', 'medium'));
    widgetRegistry.register(makeTrayWidget('lg', 'large'));

    const { result } = renderHook(() => useTrayLayout());

    expect(result.current.placements).toEqual([
      expect.objectContaining({ widgetId: 'sm', w: 2, h: 1, size: 'small' }),
      expect.objectContaining({ widgetId: 'md', w: 2, h: 2, size: 'medium' }),
      expect.objectContaining({ widgetId: 'lg', w: 2, h: 3, size: 'large' }),
    ]);
  });

  it('uses trayDefaultSize when present', () => {
    widgetRegistry.register({
      ...makeTrayWidget('status', 'large'),
      trayDefaultSize: 'small',
    });

    const { result } = renderHook(() => useTrayLayout());

    expect(result.current.placements[0]).toEqual(expect.objectContaining({ widgetId: 'status', h: 1, size: 'small' }));
  });

  it('reacts to registry changes', () => {
    widgetRegistry.register(makeTrayWidget('initial'));
    const { result } = renderHook(() => useTrayLayout());

    expect(result.current.placements).toHaveLength(1);

    act(() => {
      widgetRegistry.register(makeTrayWidget('late-arrival'));
    });

    expect(result.current.placements.map((placement) => placement.widgetId)).toEqual(['initial', 'late-arrival']);

    act(() => {
      widgetRegistry.unregister('late-arrival');
    });

    expect(result.current.placements.map((placement) => placement.widgetId)).toEqual(['initial']);
  });

  it('excludes non-tray widgets', () => {
    widgetRegistry.register(makeTrayWidget('tray-one'));
    widgetRegistry.register({ ...makeTrayWidget('global-one'), scope: 'global' });

    const { result } = renderHook(() => useTrayLayout());

    expect(result.current.placements.map((placement) => placement.widgetId)).toEqual(['tray-one']);
  });

  it('produces collision-resistant instanceIds', () => {
    widgetRegistry.register(makeTrayWidget('foo'));
    widgetRegistry.register(makeTrayWidget('locked-foo'));

    const { result } = renderHook(() => useTrayLayout(['foo']));
    const lockedPlacement = result.current.placements.find((placement) => placement.widgetId === 'foo');
    const nonLockedPlacement = result.current.placements.find((placement) => placement.widgetId === 'locked-foo');

    expect(lockedPlacement?.instanceId).toBe('tray:locked:foo');
    expect(nonLockedPlacement?.instanceId).toBe('tray:item:locked-foo');
  });

  it('pins framework built-ins in the declared lock order', () => {
    widgetRegistry.register(frameworkStatusWidgetDefinition);
    widgetRegistry.register(frameworkOpenDashboardWidgetDefinition);
    widgetRegistry.register(makeTrayWidget('third-party'));

    const { result } = renderHook(() => useTrayLayout(FRAMEWORK_TRAY_LOCKED_WIDGET_IDS));

    expect(result.current.placements).toMatchObject([
      { widgetId: frameworkStatusWidgetDefinition.id, locked: true, h: 1 },
      { widgetId: frameworkOpenDashboardWidgetDefinition.id, locked: true },
      { widgetId: 'third-party' },
    ]);
    expect(result.current.version).toBe(1);
  });
});

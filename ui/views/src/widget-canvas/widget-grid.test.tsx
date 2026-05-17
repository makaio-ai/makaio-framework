/**
 * WidgetGrid unit tests.
 *
 * Covers locked placement behaviour (static flag, no remove button) and the
 * non-responsive fixed-column mode introduced by the `gridConfig` prop.
 *
 * ## Mock strategy
 *
 * `react-grid-layout` is mocked for all tests in this file because:
 * 1. The real `WidthProvider` HOC calls `getBoundingClientRect()` during
 *    construction, which is not implemented in jsdom.
 * 2. The mock components expose distinguishable `data-testid` markers
 *    (`rgl-grid-layout` vs `rgl-responsive`) so tests can assert which
 *    layout engine branch the `WidgetGrid` selects.
 * 3. Key numeric props (`width`, `rowHeight`, `cols`) and the `margin` tuple
 *    are forwarded as `data-*` attributes for prop-passing assertions.
 */

import type { ComponentProps, ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WidgetGrid, SIZE_MAPPING, toFixedLayout } from './WidgetGrid.js';
import type { UiContextSnapshot } from '@makaio/contracts';
import type { WidgetDefinition, WidgetLayout, WidgetProps } from '@makaio/ui-kernel';
import { usePageOverlayStore } from '@makaio/ui-hooks';
import type { IMakaioBus } from '@makaio/bus-core';

type ActivationBus = Pick<IMakaioBus, 'emit' | 'request'>;

const mockHookState = vi.hoisted(() => ({
  bus: null as ActivationBus | null,
}));

vi.mock('@makaio/ui-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/ui-hooks')>();
  return {
    ...actual,
    useOptionalBus: () => mockHookState.bus,
  };
});

// ---------------------------------------------------------------------------
// react-grid-layout mock
//
// Both branches of WidgetGrid.tsx (responsive and non-responsive) are shimmed
// so tests can assert which one is active and which props it receives.
// ---------------------------------------------------------------------------

vi.mock('react-grid-layout', async () => {
  const { createElement: h } = await import('react');

  interface GridLayoutProps {
    children?: ReactNode;
    cols?: number;
    margin?: [number, number];
    rowHeight?: number;
    width?: number;
  }

  interface ResponsiveProps {
    children?: ReactNode;
  }

  /**
   * Shim for the default `GridLayout` export (fixed-column mode).
   * Renders children and forwards key numeric props as data attributes so
   * tests can assert the values without reading into internal RGL state.
   * @param props - Subset of GridLayout props relevant to the non-responsive branch.
   */
  function MockGridLayout(props: GridLayoutProps) {
    return h(
      'div',
      {
        'data-testid': 'rgl-grid-layout',
        'data-cols': props.cols,
        'data-margin': JSON.stringify(props.margin),
        'data-row-height': props.rowHeight,
        'data-width': props.width,
      },
      props.children,
    );
  }

  /**
   * Shim for the named `Responsive` export (responsive mode).
   * Renders children directly so widget tiles remain visible in the DOM.
   * @param props - Children to pass through.
   */
  function MockResponsive(props: ResponsiveProps) {
    return h('div', { 'data-testid': 'rgl-responsive' }, props.children);
  }

  /**
   * Identity wrapper — the real WidthProvider injects a resize observer.
   * We skip that in jsdom.
   * @param Component - Component to wrap.
   * @returns The unwrapped component.
   */
  function WidthProvider<T>(Component: T): T {
    return Component;
  }

  return { default: MockGridLayout, Responsive: MockResponsive, WidthProvider };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockHookState.bus = null;
  usePageOverlayStore.getState().close();
});

function MockWidget({ size }: WidgetProps) {
  return createElement('div', { 'data-testid': 'mock-widget', 'data-size': size });
}

function InteractiveWidget(): ReactNode {
  return createElement('button', { type: 'button' }, 'Inner action');
}

const TEST_UI_CONTEXT: UiContextSnapshot = {
  level: 'root',
  values: {},
};

const WIDGET_DEF: WidgetDefinition = {
  component: MockWidget,
  defaultSize: 'small',
  id: 'test-widget',
  name: 'Test Widget',
  scope: 'tray',
  supportedSizes: ['small'],
};

const ACTIVATABLE_WIDGET_DEF: WidgetDefinition = {
  ...WIDGET_DEF,
  activate: { pageId: 'test-page' },
};

const BASE_LAYOUT: WidgetLayout = {
  placements: [
    {
      col: 1,
      h: SIZE_MAPPING.small.h,
      instanceId: 'inst-1',
      row: 1,
      size: 'small',
      w: 2,
      widgetId: 'test-widget',
    },
  ],
  version: 1,
};

const WIDE_LAYOUT: WidgetLayout = {
  placements: [
    {
      col: 1,
      h: SIZE_MAPPING.large.h,
      instanceId: 'inst-wide',
      row: 1,
      size: 'large',
      w: SIZE_MAPPING.large.w,
      widgetId: 'test-widget',
    },
  ],
  version: 1,
};

const LOCKED_LAYOUT: WidgetLayout = {
  placements: [
    {
      col: 1,
      h: SIZE_MAPPING.small.h,
      instanceId: 'inst-locked',
      locked: true,
      row: 1,
      size: 'small',
      w: 2,
      widgetId: 'test-widget',
    },
  ],
  version: 1,
};

/** Non-responsive grid config reused across tray-style layout tests. */
const NON_RESPONSIVE_GRID: ComponentProps<typeof WidgetGrid>['gridConfig'] = {
  cols: 2,
  margin: [8, 8],
  responsive: false,
  rowHeight: 60,
  width: 480,
};

/**
 * Render `WidgetGrid` with sensible test defaults, merging any provided
 * overrides on top.
 *
 * Defaults:
 * - `isEditing: false`
 * - `layout: BASE_LAYOUT`
 * - `onLayoutChange: vi.fn()`
 * - `onRemoveWidget: vi.fn()`
 * - `widgets: [WIDGET_DEF]`
 * @param overrides - Props to override on top of the defaults.
 */
function renderGrid(overrides: Partial<ComponentProps<typeof WidgetGrid>> = {}): void {
  render(
    createElement(WidgetGrid, {
      isEditing: false,
      layout: BASE_LAYOUT,
      onLayoutChange: vi.fn(),
      onRemoveWidget: vi.fn(),
      uiContext: TEST_UI_CONTEXT,
      widgets: [WIDGET_DEF],
      ...overrides,
    }),
  );
}

describe('WidgetGrid — locked placements', () => {
  it('does not render a remove button for a locked placement even when isEditing=true', () => {
    renderGrid({ isEditing: true, layout: LOCKED_LAYOUT });

    expect(screen.queryByRole('button', { name: /remove widget/i })).toBeNull();
  });

  it('renders a remove button for a non-locked placement when isEditing=true', () => {
    renderGrid({ isEditing: true });

    expect(screen.getByRole('button', { name: /remove widget/i })).toBeInTheDocument();
  });

  it('does not render a remove button for any placement when isEditing=false', () => {
    renderGrid();

    expect(screen.queryByRole('button', { name: /remove widget/i })).toBeNull();
  });
});

describe('WidgetGrid — activation', () => {
  it('opens the configured page when an activatable widget is clicked outside edit mode', () => {
    renderGrid({ widgets: [ACTIVATABLE_WIDGET_DEF] });

    fireEvent.click(screen.getByTestId('mock-widget'));

    expect(usePageOverlayStore.getState().activePageId).toBe('test-page');
  });

  it('does not activate when an interactive child is clicked', () => {
    renderGrid({
      widgets: [
        {
          ...ACTIVATABLE_WIDGET_DEF,
          component: InteractiveWidget,
        },
      ],
    });

    const innerButton = screen
      .getAllByRole('button', { name: 'Inner action' })
      .find((element) => element.tagName === 'BUTTON');
    expect(innerButton).toBeDefined();
    fireEvent.click(innerButton!);

    expect(usePageOverlayStore.getState().activePageId).toBeNull();
  });

  it('activates with Enter and Space when the tile has focus', () => {
    renderGrid({ widgets: [ACTIVATABLE_WIDGET_DEF] });

    const tile = screen.getByRole('button');
    fireEvent.keyDown(tile, { key: 'Enter' });

    expect(usePageOverlayStore.getState().activePageId).toBe('test-page');

    usePageOverlayStore.getState().close();
    fireEvent.keyDown(tile, { key: ' ' });

    expect(usePageOverlayStore.getState().activePageId).toBe('test-page');
  });

  it('waits for window activation before running a custom activation handler', async () => {
    const order: string[] = [];
    mockHookState.bus = {
      emit: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockImplementation(async () => {
        order.push('window');
        return {};
      }),
    };

    renderGrid({
      widgets: [
        {
          ...WIDGET_DEF,
          activate: {
            windowId: 'account-manager:accounts-window',
            onActivate: async () => {
              order.push('custom');
            },
          },
        },
      ],
    });

    fireEvent.click(screen.getByTestId('mock-widget'));

    await waitFor(() => {
      expect(order).toEqual(['window', 'custom']);
    });
  });

  it('does not activate widgets while editing', () => {
    renderGrid({ isEditing: true, widgets: [ACTIVATABLE_WIDGET_DEF] });

    fireEvent.click(screen.getByTestId('mock-widget'));

    expect(usePageOverlayStore.getState().activePageId).toBeNull();
  });
});

describe('WidgetGrid — gridConfig non-responsive mode', () => {
  it('renders a data-component="WidgetGrid" container when gridConfig.responsive=false', () => {
    renderGrid({ gridConfig: NON_RESPONSIVE_GRID });

    expect(document.querySelector('[data-component="WidgetGrid"]')).toBeInTheDocument();
  });

  it('renders the widget tiles in non-responsive mode', () => {
    renderGrid({ gridConfig: NON_RESPONSIVE_GRID });

    expect(screen.getByTestId('mock-widget')).toBeInTheDocument();
  });

  it('renders the widget tiles in default responsive mode when gridConfig is absent', () => {
    renderGrid();

    expect(screen.getByTestId('mock-widget')).toBeInTheDocument();
  });

  it('renders the widget tiles when gridConfig.responsive=true is passed explicitly', () => {
    renderGrid({ gridConfig: { responsive: true } });

    expect(screen.getByTestId('mock-widget')).toBeInTheDocument();
  });

  it('renders successfully when explicit cols and width are provided in non-responsive mode', () => {
    renderGrid({ gridConfig: { cols: 4, responsive: false, width: 800 } });

    expect(document.querySelector('[data-component="WidgetGrid"]')).toBeInTheDocument();
    expect(screen.getByTestId('mock-widget')).toBeInTheDocument();
  });

  it('clamps fixed-layout widget widths to the configured column count', () => {
    const fixedLayout = toFixedLayout(WIDE_LAYOUT, false, [WIDGET_DEF], 2);

    expect(fixedLayout).toHaveLength(1);
    expect(fixedLayout[0]?.w).toBe(2);
    expect(fixedLayout[0]?.x).toBe(0);
    expect(fixedLayout[0]?.minW).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Component selection — GridLayout vs ResponsiveGridLayout
// ---------------------------------------------------------------------------

describe('WidgetGrid — component selection', () => {
  it('renders the fixed GridLayout component (not Responsive) when gridConfig.responsive=false', () => {
    renderGrid({ gridConfig: NON_RESPONSIVE_GRID });

    expect(screen.getByTestId('rgl-grid-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('rgl-responsive')).toBeNull();
  });

  it('renders the Responsive component (not GridLayout) when gridConfig is absent', () => {
    renderGrid();

    expect(screen.getByTestId('rgl-responsive')).toBeInTheDocument();
    expect(screen.queryByTestId('rgl-grid-layout')).toBeNull();
  });

  it('renders the Responsive component when gridConfig.responsive=true is explicit', () => {
    renderGrid({ gridConfig: { responsive: true } });

    expect(screen.getByTestId('rgl-responsive')).toBeInTheDocument();
    expect(screen.queryByTestId('rgl-grid-layout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gridConfig prop forwarding — fixed-column values reach GridLayout
// ---------------------------------------------------------------------------

describe('WidgetGrid — gridConfig prop forwarding', () => {
  it('passes gridConfig.cols to GridLayout', () => {
    renderGrid({ gridConfig: { cols: 2, responsive: false, width: 480 } });

    expect(screen.getByTestId('rgl-grid-layout')).toHaveAttribute('data-cols', '2');
  });

  it('passes gridConfig.width to GridLayout', () => {
    renderGrid({ gridConfig: { cols: 2, responsive: false, width: 480 } });

    expect(screen.getByTestId('rgl-grid-layout')).toHaveAttribute('data-width', '480');
  });

  it('passes gridConfig.rowHeight to GridLayout', () => {
    renderGrid({ gridConfig: { cols: 2, responsive: false, rowHeight: 60, width: 480 } });

    expect(screen.getByTestId('rgl-grid-layout')).toHaveAttribute('data-row-height', '60');
  });

  it('falls back to the rowHeight prop when gridConfig.rowHeight is absent', () => {
    renderGrid({ gridConfig: { cols: 2, responsive: false, width: 480 }, rowHeight: 80 });

    // rowHeight prop (80) is used when gridConfig omits rowHeight
    expect(screen.getByTestId('rgl-grid-layout')).toHaveAttribute('data-row-height', '80');
  });

  it('passes gridConfig.margin to GridLayout', () => {
    renderGrid({ gridConfig: { cols: 2, margin: [8, 8], responsive: false, width: 480 } });

    expect(screen.getByTestId('rgl-grid-layout')).toHaveAttribute('data-margin', '[8,8]');
  });

  it('defaults margin to [8, 8] when gridConfig.margin is absent', () => {
    renderGrid({ gridConfig: { cols: 2, responsive: false, width: 480 } });

    expect(screen.getByTestId('rgl-grid-layout')).toHaveAttribute('data-margin', '[8,8]');
  });
});

// ---------------------------------------------------------------------------
// toFixedLayout — static flag for locked placements
// ---------------------------------------------------------------------------

describe('toFixedLayout — locked placement static flag', () => {
  it('sets static:true for a locked placement regardless of isEditing=false', () => {
    const fixedLayout = toFixedLayout(LOCKED_LAYOUT, false, [WIDGET_DEF], 2);

    expect(fixedLayout).toHaveLength(1);
    expect(fixedLayout[0]?.static).toBe(true);
  });

  it('sets static:true for a locked placement even when isEditing=true', () => {
    const fixedLayout = toFixedLayout(LOCKED_LAYOUT, true, [WIDGET_DEF], 2);

    expect(fixedLayout).toHaveLength(1);
    expect(fixedLayout[0]?.static).toBe(true);
  });

  it('sets static:true for a non-locked placement when isEditing=false (grid-level lock)', () => {
    const fixedLayout = toFixedLayout(BASE_LAYOUT, false, [WIDGET_DEF], 2);

    expect(fixedLayout).toHaveLength(1);
    expect(fixedLayout[0]?.static).toBe(true);
  });

  it('sets static:false for a non-locked placement when isEditing=true', () => {
    const fixedLayout = toFixedLayout(BASE_LAYOUT, true, [WIDGET_DEF], 2);

    expect(fixedLayout).toHaveLength(1);
    expect(fixedLayout[0]?.static).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WIDGET_DRAG_DATA_TYPE, getWidgetDragData, setWidgetDragData } from './drag-payload.js';
import { deriveWidgetSize, SIZE_MAPPING } from './WidgetGrid.js';
import { WidgetCanvas } from './WidgetCanvas.js';
import type { WidgetDefinition } from '@makaio/ui-kernel';
import type { WidgetCanvasProps } from './types.js';

// react-grid-layout's WidthProvider calls getBoundingClientRect() during
// construction — that API is not implemented in jsdom. Replace the module
// with a minimal shim that renders children directly so component rendering
// tests can focus on WidgetCanvas behaviour rather than layout measurement.
vi.mock('react-grid-layout', async () => {
  const { default: React } = await import('react');

  /**
   * Minimal shim for the RGL Responsive grid.
   * Renders children as-is so individual widget tiles are visible in the DOM.
   * @param props - Children to render inside the grid container.
   */
  function MockResponsive(props: { children?: React.ReactNode }): React.ReactElement {
    return React.createElement('div', { 'data-testid': 'rgl-grid' }, props.children);
  }

  /**
   * Identity wrapper — returns the component unchanged.
   * The real WidthProvider HOC adds a resize observer; we skip that in jsdom.
   * @param Component - The component to wrap.
   * @returns The same component, unchanged.
   */
  function WidthProvider<T>(Component: T): T {
    return Component;
  }

  return { Responsive: MockResponsive, WidthProvider };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal no-op widget component for use in test WidgetDefinition fixtures.
 */
function NoopWidget(): null {
  return null;
}

/**
 * Build a minimal WidgetDefinition suitable for test fixtures.
 * @param id - Unique widget identifier.
 * @param name - Display name.
 * @returns A valid WidgetDefinition with sensible defaults.
 */
function makeWidgetDefinition(id: string, name: string): WidgetDefinition {
  return {
    id,
    name,
    scope: 'global',
    component: NoopWidget,
    supportedSizes: ['medium'],
    defaultSize: 'medium',
    allowMultiple: true,
  };
}

/** Required onSaveLayout stub that resolves immediately. */
const noopSave: WidgetCanvasProps['onSaveLayout'] = () => Promise.resolve();

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// drag-payload — pure function tests
// ---------------------------------------------------------------------------

describe('drag-payload', () => {
  describe('setWidgetDragData', () => {
    it('serialises the widget ID under the canonical MIME type', () => {
      const store: Record<string, string> = {};
      const dt = {
        getData: (type: string) => store[type] ?? '',
        setData: (type: string, data: string) => {
          store[type] = data;
        },
      };

      setWidgetDragData(dt, { widgetId: 'git-status' });

      expect(store[WIDGET_DRAG_DATA_TYPE]).toBe(JSON.stringify({ widgetId: 'git-status' }));
    });
  });

  describe('getWidgetDragData', () => {
    it('returns null when the DataTransfer argument is null', () => {
      expect(getWidgetDragData(null)).toBeNull();
    });

    it('returns null when the DataTransfer argument is undefined', () => {
      expect(getWidgetDragData(undefined)).toBeNull();
    });

    it('returns null when there is no payload under the MIME type', () => {
      const dt = {
        getData: () => '',
        setData: vi.fn(),
      };
      expect(getWidgetDragData(dt)).toBeNull();
    });

    it('returns null for syntactically invalid JSON', () => {
      const dt = {
        getData: () => 'not-json',
        setData: vi.fn(),
      };
      expect(getWidgetDragData(dt)).toBeNull();
    });

    it('returns null when the payload lacks a widgetId string', () => {
      const dt = {
        getData: () => JSON.stringify({ other: 'field' }),
        setData: vi.fn(),
      };
      expect(getWidgetDragData(dt)).toBeNull();
    });

    it('returns null when widgetId is not a string', () => {
      const dt = {
        getData: () => JSON.stringify({ widgetId: 42 }),
        setData: vi.fn(),
      };
      expect(getWidgetDragData(dt)).toBeNull();
    });

    it('round-trips through setWidgetDragData', () => {
      const store: Record<string, string> = {};
      const dt = {
        getData: (type: string) => store[type] ?? '',
        setData: (type: string, data: string) => {
          store[type] = data;
        },
      };

      setWidgetDragData(dt, { widgetId: 'my-widget' });

      expect(getWidgetDragData(dt)).toEqual({ widgetId: 'my-widget' });
    });
  });
});

// ---------------------------------------------------------------------------
// deriveWidgetSize — pure function tests
// ---------------------------------------------------------------------------

describe('deriveWidgetSize', () => {
  it('returns "full-width" for heights of 4 and above', () => {
    expect(deriveWidgetSize(4)).toBe('full-width');
    expect(deriveWidgetSize(10)).toBe('full-width');
  });

  it('returns "large" for height exactly 3', () => {
    expect(deriveWidgetSize(3)).toBe('large');
  });

  it('returns "medium" for height exactly 2', () => {
    expect(deriveWidgetSize(2)).toBe('medium');
  });

  it('returns "small" for heights below 2', () => {
    expect(deriveWidgetSize(1)).toBe('small');
    expect(deriveWidgetSize(0)).toBe('small');
  });

  it('is consistent with SIZE_MAPPING heights — large and full-width have unique heights', () => {
    // large and full-width have unique heights so they round-trip cleanly.
    // small and medium both use h:2; deriveWidgetSize returns 'medium' for h:2
    // because medium is the higher-priority tier. This is by design: height-based
    // derivation serves responsive rendering, not exact size reconstruction.
    expect(deriveWidgetSize(SIZE_MAPPING['full-width'].h)).toBe('full-width');
    expect(deriveWidgetSize(SIZE_MAPPING.large.h)).toBe('large');
    expect(deriveWidgetSize(SIZE_MAPPING.medium.h)).toBe('medium');
    // small deliberately shares h:2 with medium — deriveWidgetSize is not
    // expected to reconstruct 'small' from the canonical h:2 height.
    expect(deriveWidgetSize(SIZE_MAPPING.small.h)).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// WidgetCanvas component — rendering tests
// ---------------------------------------------------------------------------

describe('WidgetCanvas', () => {
  describe('loading state', () => {
    it('renders the loading message when isLoading is true', () => {
      const { container } = render(<WidgetCanvas isLoading widgets={[]} onSaveLayout={noopSave} />);

      expect(container.querySelector('[data-component="WidgetCanvasLoadingState"]')).toBeTruthy();
      expect(screen.getByRole('status')).toHaveTextContent('Loading dashboard...');
    });

    it('does not render the grid while loading', () => {
      const { container } = render(<WidgetCanvas isLoading widgets={[]} onSaveLayout={noopSave} />);

      expect(container.querySelector('[data-component="WidgetCanvas"]')).toBeNull();
    });
  });

  describe('error state', () => {
    it('renders the error message when an error is provided', () => {
      const { container } = render(
        <WidgetCanvas error={new Error('Preferences unavailable')} widgets={[]} onSaveLayout={noopSave} />,
      );

      expect(container.querySelector('[data-component="WidgetCanvasErrorState"]')).toBeTruthy();
      expect(screen.getByRole('alert')).toHaveTextContent('Error loading dashboard: Preferences unavailable');
    });

    it('does not render the grid when in error state', () => {
      const { container } = render(<WidgetCanvas error={new Error('oops')} widgets={[]} onSaveLayout={noopSave} />);

      expect(container.querySelector('[data-component="WidgetCanvas"]')).toBeNull();
    });
  });

  describe('empty state', () => {
    it('shows the empty-dashboard prompt when there are no placements', () => {
      const { container } = render(
        <WidgetCanvas savedLayout={{ version: 1, placements: [] }} widgets={[]} onSaveLayout={noopSave} />,
      );

      expect(container.querySelector('[data-component="WidgetCanvasEmptyState"]')).toBeTruthy();
      expect(screen.getByText('Empty Dashboard')).toBeTruthy();
    });

    it('renders the canvas wrapper in the normal state', () => {
      const { container } = render(
        <WidgetCanvas savedLayout={{ version: 1, placements: [] }} widgets={[]} onSaveLayout={noopSave} />,
      );

      expect(container.querySelector('[data-component="WidgetCanvas"]')).toBeTruthy();
    });

    it('renders the grid sub-component', () => {
      const { container } = render(
        <WidgetCanvas savedLayout={{ version: 1, placements: [] }} widgets={[]} onSaveLayout={noopSave} />,
      );

      expect(container.querySelector('[data-component="WidgetGrid"]')).toBeTruthy();
    });
  });

  describe('with placements', () => {
    it('does not show the empty-state prompt when placements are present', () => {
      const widget = makeWidgetDefinition('clock', 'Clock');
      const layout = {
        version: 1 as const,
        placements: [
          {
            instanceId: 'inst-1',
            widgetId: 'clock',
            col: 1,
            row: 1,
            size: 'medium' as const,
          },
        ],
      };

      render(<WidgetCanvas savedLayout={layout} widgets={[widget]} onSaveLayout={noopSave} />);

      expect(screen.queryByText('Empty Dashboard')).toBeNull();
    });
  });

  describe('edit mode', () => {
    it('renders the WidgetPalette when isEditing is true and the container has dimensions', () => {
      // The WidgetPalette depends on getBoundingClientRect() to compute its
      // initial floating position. Stub it so the palette becomes visible.
      const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = vi.fn(
        () =>
          ({
            bottom: 600,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            width: 800,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      );

      try {
        render(
          <WidgetCanvas
            isEditing
            savedLayout={{ version: 1, placements: [] }}
            widgets={[makeWidgetDefinition('clock', 'Clock')]}
            onSaveLayout={noopSave}
            onToggleEdit={vi.fn()}
          />,
        );

        expect(screen.getByRole('dialog', { name: 'Widget Palette' })).toBeTruthy();
      } finally {
        Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      }
    });

    it('does not render the WidgetPalette when isEditing is false', () => {
      const { container } = render(
        <WidgetCanvas
          isEditing={false}
          savedLayout={{ version: 1, placements: [] }}
          widgets={[makeWidgetDefinition('clock', 'Clock')]}
          onSaveLayout={noopSave}
          onToggleEdit={vi.fn()}
        />,
      );

      expect(container.querySelector('[data-component="WidgetPalette"]')).toBeNull();
    });
  });

  describe('isLoading default', () => {
    it('defaults isLoading to false and renders the canvas', () => {
      const { container } = render(<WidgetCanvas widgets={[]} onSaveLayout={noopSave} />);

      // When isLoading defaults to false and error is null, canvas renders.
      expect(container.querySelector('[data-component="WidgetCanvas"]')).toBeTruthy();
    });
  });
});

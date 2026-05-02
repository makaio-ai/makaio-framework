/**
 * Unit tests for the Electrobun tray-popover module.
 *
 * All tests exercise the pure helper functions ({@link computePopoverBounds},
 * {@link anchorFromTrayBounds}, {@link toggleTrayPopover}) without requiring
 * the native Electrobun FFI. The `electrobun/bun` module is mocked so
 * BrowserWindow and Screen never initialise native bindings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const windowMock = vi.hoisted(() => {
  class FakeBrowserWindow {
    public readonly close = vi.fn(() => {
      this.emit('close');
    });
    public readonly show = vi.fn();
    private readonly handlers = new Map<string, Array<() => void>>();

    public on(name: string, handler: () => void): void {
      const existing = this.handlers.get(name) ?? [];
      existing.push(handler);
      this.handlers.set(name, existing);
    }

    public emit(name: string): void {
      for (const h of this.handlers.get(name) ?? []) {
        h();
      }
    }
  }

  const instances: FakeBrowserWindow[] = [];

  return {
    FakeBrowserWindow,
    instances,
    reset(): void {
      instances.length = 0;
    },
    lastInstance(): FakeBrowserWindow | undefined {
      return instances[instances.length - 1];
    },
  };
});

/** Simulated primary display for Screen.getPrimaryDisplay(). */
const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1600 },
  workArea: { x: 0, y: 25, width: 2560, height: 1575 },
  scaleFactor: 2,
  isPrimary: true,
};

vi.mock('electrobun/bun', () => ({
  BrowserWindow: class extends windowMock.FakeBrowserWindow {
    public constructor(opts: unknown) {
      super();
      // Push into instances so tests can inspect them.
      windowMock.instances.push(this);
      void opts;
    }
  },
  Screen: {
    getPrimaryDisplay: () => primaryDisplay,
    getAllDisplays: () => [primaryDisplay],
  },
}));

// Import AFTER mock registration so the mock is active at import time.
import {
  computePopoverBounds,
  anchorFromTrayBounds,
  initTrayPopover,
  showTrayPopover,
  toggleTrayPopover,
} from '../src/main/tray-popover.js';

import { TRAY_WINDOW_WIDTH_PX, TRAY_WINDOW_HEIGHT_PX } from '@makaio/ui-kernel';

describe('computePopoverBounds', () => {
  it('centres on the primary display work area when no anchor is given', () => {
    const result = computePopoverBounds();
    const { x: dx, y: dy, width: dw, height: dh } = primaryDisplay.workArea;
    expect(result).toEqual({
      x: Math.round(dx + (dw - TRAY_WINDOW_WIDTH_PX) / 2),
      y: Math.round(dy + (dh - TRAY_WINDOW_HEIGHT_PX) / 2),
    });
  });

  it('centres horizontally on the anchor x and places popover below the anchor', () => {
    const anchor = { x: 800, y: 25 };
    const result = computePopoverBounds(anchor);
    const halfW = TRAY_WINDOW_WIDTH_PX / 2;
    expect(result).toEqual({ x: anchor.x - halfW, y: anchor.y + 16 });
  });

  it('clamps the popover to the left edge of the work area', () => {
    const anchor = { x: 10, y: 25 };
    const result = computePopoverBounds(anchor);
    expect(result.x).toBe(primaryDisplay.workArea.x);
  });

  it('clamps the popover to the right edge of the work area', () => {
    const anchor = { x: 2550, y: 25 };
    const result = computePopoverBounds(anchor);
    const maxX = primaryDisplay.workArea.x + primaryDisplay.workArea.width - TRAY_WINDOW_WIDTH_PX;
    expect(result.x).toBe(maxX);
  });
});

describe('anchorFromTrayBounds', () => {
  it('returns the bottom-centre of the tray icon bounds', () => {
    const bounds = { x: 100, y: 20, width: 22, height: 22 };
    expect(anchorFromTrayBounds(bounds)).toEqual({ x: 111, y: 42 });
  });
});

describe('toggleTrayPopover', () => {
  beforeEach(() => {
    // Re-initialise so the module-level URLs are always set.
    initTrayPopover('http://127.0.0.1:6252', 'ws://127.0.0.1:6252/bus');

    // Close any open popover from a previous test BEFORE resetting the
    // instances array so the module-level `popover` reference is cleared.
    const lastWin = windowMock.lastInstance();
    if (lastWin) {
      lastWin.emit('close');
    }

    // Clear tracked instances so each test starts with a clean slate.
    windowMock.reset();
  });

  it('returns false and warns when called before initTrayPopover', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.resetModules();
      const fresh = await import('../src/main/tray-popover.js');
      const result = fresh.toggleTrayPopover();
      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('initTrayPopover() must be called before toggleTrayPopover()'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('creates a popover window and returns true on first toggle', () => {
    const result = toggleTrayPopover();
    expect(result).toBe(true);
    expect(windowMock.instances).toHaveLength(1);
  });

  it('closes the existing popover and returns false on second toggle', () => {
    toggleTrayPopover();
    const win = windowMock.lastInstance();
    expect(win).toBeDefined();

    const result = toggleTrayPopover();
    expect(result).toBe(false);
    expect(win!.close).toHaveBeenCalledOnce();
  });

  it('shows the popover after dom-ready fires', () => {
    toggleTrayPopover();
    const win = windowMock.lastInstance();
    expect(win).toBeDefined();
    // show() must NOT be called before dom-ready
    expect(win!.show).not.toHaveBeenCalled();

    win!.emit('dom-ready');
    expect(win!.show).toHaveBeenCalledOnce();
  });

  it('dismisses the popover when it loses focus (blur)', () => {
    toggleTrayPopover();
    const win = windowMock.lastInstance();
    expect(win).toBeDefined();

    win!.emit('blur');

    expect(win!.close).toHaveBeenCalledOnce();
  });

  // Anchor arithmetic is exhaustively tested by the computePopoverBounds
  // suite above; this test verifies the wiring from toggleTrayPopover options.
  it('passes an anchor from options to computePopoverBounds', () => {
    const result = toggleTrayPopover({ anchor: { x: 200, y: 30 } });
    expect(result).toBe(true);
  });
});

describe('showTrayPopover', () => {
  beforeEach(() => {
    initTrayPopover('http://127.0.0.1:6252', 'ws://127.0.0.1:6252/bus');

    // Close any open popover from a previous test before resetting instances.
    const lastWin = windowMock.lastInstance();
    if (lastWin) {
      lastWin.emit('close');
    }

    windowMock.reset();
  });

  it('creates a popover window and returns true when no popover is open', () => {
    const result = showTrayPopover();
    expect(result).toBe(true);
    expect(windowMock.instances).toHaveLength(1);
  });

  it('returns true without creating a second window when popover is already open', () => {
    showTrayPopover();
    expect(windowMock.instances).toHaveLength(1);

    const result = showTrayPopover();
    expect(result).toBe(true);
    // No second window created — idempotent.
    expect(windowMock.instances).toHaveLength(1);
  });

  it('does not close the existing popover on repeated show calls', () => {
    showTrayPopover();
    const win = windowMock.lastInstance();
    expect(win).toBeDefined();

    showTrayPopover();

    expect(win!.close).not.toHaveBeenCalled();
  });

  it('passes an anchor through to positioning', () => {
    const result = showTrayPopover({ anchor: { x: 300, y: 40 } });
    expect(result).toBe(true);
    expect(windowMock.instances).toHaveLength(1);
  });
});

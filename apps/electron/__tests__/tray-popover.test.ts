/**
 * Unit tests for the Electron tray-popover module.
 *
 * All native Electron APIs (`BrowserWindow`, `app`, `screen`), path utilities,
 * and the `@makaio/ui-kernel` dimension constants are replaced with in-process
 * fakes so the tests run without Electron installed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted fake BrowserWindow factory — must be declared before vi.mock calls.
// ---------------------------------------------------------------------------

const windowMock = vi.hoisted(() => {
  class FakeBrowserWindow {
    public readonly loadURL = vi.fn(() => Promise.resolve());
    public readonly show = vi.fn();
    public readonly close = vi.fn(() => {
      this.emit('closed');
    });
    public readonly isDestroyed = vi.fn(() => false);

    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    public on(name: string, handler: (...args: unknown[]) => void): void {
      const existing = this.handlers.get(name) ?? [];
      existing.push(handler);
      this.handlers.set(name, existing);
    }

    public once(name: string, handler: (...args: unknown[]) => void): void {
      const wrapper = (...args: unknown[]): void => {
        handler(...args);
        const list = this.handlers.get(name) ?? [];
        const idx = list.indexOf(wrapper);
        if (idx !== -1) list.splice(idx, 1);
      };
      this.on(name, wrapper);
    }

    public emit(name: string, ...args: unknown[]): void {
      for (const h of [...(this.handlers.get(name) ?? [])]) {
        h(...args);
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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Simulated primary display for screen.*. */
const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1600 },
  workArea: { x: 0, y: 25, width: 2560, height: 1575 },
  scaleFactor: 2,
};

const appMock = vi.hoisted(() => ({
  once: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: class extends windowMock.FakeBrowserWindow {
    public constructor(opts: unknown) {
      super();
      windowMock.instances.push(this);
      void opts;
    }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => primaryDisplay,
  },
}));

// Path utilities resolve deterministically in tests — preload path is irrelevant.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, join: (...parts: string[]) => parts.join('/') };
});

vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>();
  return { ...actual, fileURLToPath: (_url: string) => '/fake/dist/main' };
});

vi.mock('@makaio/ui-kernel', () => ({
  TRAY_WINDOW_WIDTH_PX: 400,
  TRAY_WINDOW_HEIGHT_PX: 600,
}));

// ---------------------------------------------------------------------------
// Imports (after mock registration)
// ---------------------------------------------------------------------------

import { computePopoverBounds, initTrayPopover, showTrayPopover, toggleTrayPopover } from '../src/main/tray-popover.js';

import { TRAY_WINDOW_WIDTH_PX, TRAY_WINDOW_HEIGHT_PX } from '@makaio/ui-kernel';

// ---------------------------------------------------------------------------
// computePopoverBounds
// ---------------------------------------------------------------------------

describe('computePopoverBounds', () => {
  it('centres on the display work area when no anchor is given', () => {
    const result = computePopoverBounds();
    const { x: dx, y: dy, width: dw, height: dh } = primaryDisplay.workArea;
    expect(result).toEqual({
      x: Math.round(dx + (dw - TRAY_WINDOW_WIDTH_PX) / 2),
      y: Math.round(dy + (dh - TRAY_WINDOW_HEIGHT_PX) / 2),
    });
  });

  it('centres horizontally on the anchor x and places the popover below it', () => {
    const anchor = { x: 800, y: 25 };
    const result = computePopoverBounds(anchor);
    expect(result).toEqual({
      x: anchor.x - TRAY_WINDOW_WIDTH_PX / 2,
      y: anchor.y + 16,
    });
  });

  it('clamps the popover to the left edge of the work area', () => {
    const result = computePopoverBounds({ x: 10, y: 25 });
    expect(result.x).toBe(primaryDisplay.workArea.x);
  });

  it('clamps the popover to the right edge of the work area', () => {
    const result = computePopoverBounds({ x: 2550, y: 25 });
    const maxX = primaryDisplay.workArea.x + primaryDisplay.workArea.width - TRAY_WINDOW_WIDTH_PX;
    expect(result.x).toBe(maxX);
  });
});

// ---------------------------------------------------------------------------
// toggleTrayPopover
// ---------------------------------------------------------------------------

describe('toggleTrayPopover', () => {
  beforeEach(() => {
    initTrayPopover('http://127.0.0.1:6252', 'ws://127.0.0.1:6252/bus');

    // Drain any open popover before resetting the instances array.
    const lastWin = windowMock.lastInstance();
    if (lastWin) {
      lastWin.emit('closed');
    }

    windowMock.reset();
    appMock.once.mockClear();
    appMock.on.mockClear();
    appMock.off.mockClear();
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

  it('shows the popover after ready-to-show fires', () => {
    toggleTrayPopover();
    const win = windowMock.lastInstance();
    expect(win).toBeDefined();
    // show() must NOT be called before ready-to-show
    expect(win!.show).not.toHaveBeenCalled();

    win!.emit('ready-to-show');
    expect(win!.show).toHaveBeenCalledOnce();
  });

  it('dismisses the popover when it loses focus (blur)', () => {
    toggleTrayPopover();
    const win = windowMock.lastInstance();
    expect(win).toBeDefined();

    win!.emit('blur');

    expect(win!.close).toHaveBeenCalledOnce();
  });

  it('passes an anchor from options to computePopoverBounds', () => {
    const result = toggleTrayPopover({ anchor: { x: 200, y: 30 } });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// showTrayPopover
// ---------------------------------------------------------------------------

describe('showTrayPopover', () => {
  beforeEach(() => {
    initTrayPopover('http://127.0.0.1:6252', 'ws://127.0.0.1:6252/bus');

    // Drain any open popover before resetting the instances array.
    const lastWin = windowMock.lastInstance();
    if (lastWin) {
      lastWin.emit('closed');
    }

    windowMock.reset();
    appMock.once.mockClear();
    appMock.on.mockClear();
    appMock.off.mockClear();
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

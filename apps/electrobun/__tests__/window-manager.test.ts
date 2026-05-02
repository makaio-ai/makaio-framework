import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowRegistry } from '@makaio/kernel';

const electrobunMock = vi.hoisted(() => {
  let nextId = 1;
  const instances: FakeBrowserWindow[] = [];

  /** Simulated primary display returned by Screen.getPrimaryDisplay(). */
  const primaryDisplay = {
    id: 1,
    bounds: { x: 0, y: 0, width: 2560, height: 1600 },
    workArea: { x: 0, y: 25, width: 2560, height: 1575 },
    scaleFactor: 2,
    isPrimary: true,
  };

  class FakeBrowserWindow {
    public readonly id = nextId++;
    public readonly title: string;
    public readonly titleBarStyle: string;
    public readonly url: string;
    public frame: { x: number; y: number; width: number; height: number };
    public showCalls = 0;
    public focusCalls = 0;
    public minimizeCalls = 0;
    public unminimizeCalls = 0;
    public closeCalls = 0;
    public setPositionCalls: Array<{ x: number; y: number }> = [];
    public minimized = false;
    public closed = false;

    private readonly handlers = new Map<string, Array<(event: unknown) => void>>();

    public constructor(options: {
      title: string;
      titleBarStyle: string;
      url: string;
      frame: { x: number; y: number; width: number; height: number };
    }) {
      this.title = options.title;
      this.titleBarStyle = options.titleBarStyle;
      this.url = options.url;
      this.frame = options.frame;
      instances.push(this);
    }

    public on(name: string, handler: (event: unknown) => void): void {
      const existing = this.handlers.get(name) ?? [];
      existing.push(handler);
      this.handlers.set(name, existing);
    }

    public emit(name: string, event?: unknown): void {
      for (const handler of this.handlers.get(name) ?? []) {
        handler(event);
      }
    }

    public show(): void {
      this.showCalls += 1;
    }

    public focus(): void {
      this.focusCalls += 1;
    }

    public minimize(): void {
      this.minimizeCalls += 1;
      this.minimized = true;
    }

    public unminimize(): void {
      this.unminimizeCalls += 1;
      this.minimized = false;
    }

    public isMinimized(): boolean {
      return this.minimized;
    }

    public close(): void {
      this.closeCalls += 1;
      this.closed = true;
      // Fire the close event so listeners (e.g. registry cleanup) are triggered.
      this.emit('close');
    }

    public getFrame(): { x: number; y: number; width: number; height: number } {
      return this.frame;
    }

    public setPosition(x: number, y: number): void {
      this.setPositionCalls.push({ x, y });
      this.frame = { ...this.frame, x, y };
    }
  }

  return {
    FakeBrowserWindow,
    primaryDisplay,
    instances,
    reset(): void {
      nextId = 1;
      instances.length = 0;
    },
  };
});

vi.mock('electrobun/bun', () => ({
  BrowserWindow: electrobunMock.FakeBrowserWindow,
  Screen: {
    getPrimaryDisplay: () => electrobunMock.primaryDisplay,
    getAllDisplays: () => [electrobunMock.primaryDisplay],
  },
}));

import { WindowManager } from '../src/main/window-manager.js';

function createWindowRegistry(): WindowRegistry {
  const registry = new WindowRegistry();
  registry.register('test-ext', 'Tray Popover', {
    id: 'popover',
    style: 'tray-popover',
    singleton: true,
    width: 320,
    height: 180,
  });
  registry.register('test-ext', 'Utility Window', {
    id: 'utility',
    style: 'utility',
    singleton: false,
    width: 500,
    height: 400,
  });
  return registry;
}

function createWindowManager(): WindowManager {
  return new WindowManager({
    port: 6252,
    isDev: false,
    windowRegistry: createWindowRegistry(),
  });
}

describe('Electrobun WindowManager', () => {
  beforeEach(() => {
    electrobunMock.reset();
  });

  it('restores minimized singleton windows before focusing them again', () => {
    const manager = createWindowManager();
    const first = manager.createWindow({ registrationId: 'test-ext:popover' });
    const browserWindow = electrobunMock.instances[0];

    browserWindow.minimize();

    const second = manager.createWindow({ registrationId: 'test-ext:popover' });

    expect(second).toEqual({ windowId: first.windowId, isNew: false });
    expect(browserWindow.unminimizeCalls).toBe(1);
    expect(browserWindow.showCalls).toBe(1);
    expect(browserWindow.focusCalls).toBe(1);
    expect(browserWindow.minimized).toBe(false);
  });

  it('showAll restores minimized windows through the shared bring-to-front path', () => {
    const manager = createWindowManager();
    manager.createWindow({ registrationId: 'test-ext:popover' });
    manager.createWindow({ registrationId: 'test-ext:utility' });

    const [popoverWindow, utilityWindow] = electrobunMock.instances;
    popoverWindow.minimize();

    manager.showAll();

    expect(popoverWindow.unminimizeCalls).toBe(1);
    expect(popoverWindow.showCalls).toBe(1);
    expect(popoverWindow.focusCalls).toBe(1);
    expect(utilityWindow.unminimizeCalls).toBe(0);
    expect(utilityWindow.showCalls).toBe(1);
    expect(utilityWindow.focusCalls).toBe(1);
  });

  it('positions tray-popover using the primary display work area (display-aware)', () => {
    const manager = createWindowManager();
    manager.createWindow({ registrationId: 'test-ext:popover' });

    const browserWindow = electrobunMock.instances[0];
    // Should have called setPosition to place the popover at the bottom-right
    // of the primary display work area (2560x1600, workArea y=25, h=1575).
    // Expected x = 0 + 2560 - 320 - 8 = 2232, y = 25 + 1575 - 180 - 8 = 1412
    expect(browserWindow.setPositionCalls).toHaveLength(1);
    expect(browserWindow.setPositionCalls[0]).toEqual({ x: 2232, y: 1412 });
  });

  // Asserts the dismissOnBlur policy: blur fires close(), not minimize().
  // Recreation after blur is tested by the createWindow singleton tests (L151-165).
  it('tray-popover with dismissOnBlur closes (not minimises) on blur', () => {
    const manager = createWindowManager();
    manager.createWindow({ registrationId: 'test-ext:popover' });

    const browserWindow = electrobunMock.instances[0];
    browserWindow.emit('blur');

    expect(browserWindow.closeCalls).toBe(1);
    expect(browserWindow.minimizeCalls).toBe(0);
  });

  it('rejects custom params that collide with bootstrap query keys', () => {
    const manager = createWindowManager();

    expect(() =>
      manager.createWindow({
        registrationId: 'test-ext:utility',
        params: { app: 'override' },
      }),
    ).toThrow('Window param "app" is reserved by the Electrobun bootstrap contract.');
  });

  it('injects the qualified window registration ID into the renderer URL', () => {
    const manager = createWindowManager();

    manager.createWindow({ registrationId: 'test-ext:utility', params: { projectId: 'project-123' } });

    const browserWindow = electrobunMock.instances[0];
    const url = new URL(browserWindow.url);

    expect(url.searchParams.get('app')).toBe('test-ext');
    expect(url.searchParams.get('window')).toBe('test-ext:utility');
    expect(url.searchParams.get('projectId')).toBe('project-123');
  });

  it('finds open windows by registration ID', () => {
    const manager = createWindowManager();
    const created = manager.createWindow({ registrationId: 'test-ext:utility' });

    const found = manager.findByRegistrationId('test-ext:utility');

    expect(found).toMatchObject({
      windowId: created.windowId,
      registrationId: 'test-ext:utility',
    });
    expect(manager.findByRegistrationId('test-ext:missing')).toBeUndefined();
  });
});

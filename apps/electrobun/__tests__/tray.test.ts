import { describe, expect, it, vi } from 'vitest';
import type { TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import type { WindowManagerState } from '@makaio/host-shared';
import type { WindowRegistration } from '@makaio/kernel';
import { buildTrayMenuTemplate, handleTrayAction, type TrayDeps } from '../src/main/tray.js';

// `tray.ts` imports the native `Tray` class from `electrobun/bun` at module level.
// The electrobun package uses Bun-native globals (`Bun.serve`) that crash in
// Vitest/Node. Supply a factory mock so Vitest never imports the real package.
vi.mock('electrobun/bun', () => ({
  Tray: vi.fn().mockImplementation(() => ({
    setMenu: vi.fn(),
    on: vi.fn(),
    remove: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 100, y: 20, width: 22, height: 22 }),
  })),
}));

// `tray-popover.ts` imports `BrowserWindow` and `Screen` from `electrobun/bun`,
// which also crash in Node. Mock the entire module to avoid FFI initialisation.
vi.mock('../src/main/tray-popover.js', () => ({
  toggleTrayPopover: vi.fn().mockReturnValue(true),
  anchorFromTrayBounds: vi
    .fn()
    .mockImplementation((bounds: { x: number; y: number; width: number; height: number }) => ({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
    })),
  initTrayPopover: vi.fn(),
  computePopoverBounds: vi.fn().mockReturnValue({ x: 0, y: 0 }),
}));

function makeWindow(
  overrides: Partial<WindowManagerState> & { windowId: number; registrationId: string },
): WindowManagerState {
  return {
    label: overrides.registrationId,
    visible: true,
    focused: false,
    ...overrides,
  };
}

function makeRegistration(overrides: Partial<WindowRegistration> & { qualifiedId: string }): WindowRegistration {
  const [packageName = overrides.qualifiedId, windowId = 'main'] = overrides.qualifiedId.split(':');
  return {
    packageName,
    windowId,
    displayName: overrides.qualifiedId,
    style: 'utility',
    width: 900,
    height: 700,
    showInDock: true,
    dismissOnBlur: false,
    frame: true,
    singleton: false,
    ...overrides,
  };
}

function makeTrayEntry(
  label: string,
  entryId: string,
  section: TrayMenuListEntry['section'] = 'utilities',
  metadata?: TrayMenuListEntry['metadata'],
): TrayMenuListEntry {
  return {
    packageName: 'pkg',
    entryId,
    label,
    section,
    priority: 50,
    enabled: true,
    metadata,
  };
}

function makeWindowTrayEntry(
  label: string,
  registrationId: string,
  section: TrayMenuListEntry['section'] = 'utilities',
): TrayMenuListEntry {
  return makeTrayEntry(label, registrationId, section, { registrationId });
}

function findMenuItem(label: string, items: ReturnType<typeof buildTrayMenuTemplate>) {
  const item = items.find((candidate) => candidate.type === 'normal' && candidate.label === label);
  expect(item).toBeDefined();
  return item;
}

function makeTrayDeps(overrides: Partial<TrayDeps> = {}): TrayDeps {
  return {
    iconPath: '/tmp/icon.png',
    listWindows: () => [],
    listRegistrations: () => [],
    getEntries: () => [],
    focusWindow: vi.fn(),
    createWindow: vi.fn(),
    onItemClicked: vi.fn(),
    openDashboard: vi.fn(),
    onQuit: vi.fn(),
    autoLaunchEnabled: null,
    toggleAutoLaunch: vi.fn(),
    ...overrides,
  };
}

function expectCalledBefore(first: ReturnType<typeof vi.fn>, second: ReturnType<typeof vi.fn>): void {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
}

describe('Electrobun tray', () => {
  it('Dashboard is always the first menu item', () => {
    const items = buildTrayMenuTemplate([], [], []);
    expect(items[0]).toMatchObject({ label: 'Dashboard', type: 'normal' });
  });

  it('Dashboard + Quit only when no windows or entries', () => {
    const items = buildTrayMenuTemplate([], [], []);
    // Dashboard, separator before Quit, Quit
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ label: 'Dashboard', type: 'normal' });
    expect(items[1]).toMatchObject({ type: 'separator' });
    expect(items[2]).toMatchObject({ label: 'Quit', type: 'normal' });
  });

  it('Dashboard action is open-dashboard when callbacks are provided', () => {
    const items = buildTrayMenuTemplate([], [], [], {
      focusWindow: vi.fn(),
      createWindow: vi.fn(),
      onItemClicked: vi.fn(),
      openDashboard: vi.fn(),
    });
    expect(items[0]).toMatchObject({ label: 'Dashboard', action: 'open-dashboard' });
  });

  it('Dashboard action is undefined when no callbacks (test mode)', () => {
    const items = buildTrayMenuTemplate([], [], []);
    expect(items[0]).toMatchObject({ label: 'Dashboard', action: undefined });
  });

  it('shows Launch at Login item with checked state when auto-launch is supported', () => {
    const itemsEnabled = buildTrayMenuTemplate([], [], [], undefined, true);
    expect(findMenuItem('Launch at Login', itemsEnabled)).toMatchObject({ checked: true });

    const itemsDisabled = buildTrayMenuTemplate([], [], [], undefined, false);
    expect(findMenuItem('Launch at Login', itemsDisabled)).toMatchObject({ checked: false });
  });

  it('builds Dashboard first, then live window items, then launcher items with separators', () => {
    const windows: WindowManagerState[] = [
      makeWindow({
        windowId: 1,
        registrationId: 'test-app.editor:main',
        label: 'Acme Workspace',
        params: { projectId: 'p1' },
        focused: true,
      }),
      makeWindow({
        windowId: 3,
        registrationId: 'test-app.editor:secondary',
        label: 'Fix auth bug',
        params: { sessionId: 's3' },
      }),
    ];
    const trayEntries: TrayMenuListEntry[] = [
      makeWindowTrayEntry('Analytics', 'test-app.analytics:main'),
      makeWindowTrayEntry('Monitor', 'test-app.monitor:main'),
    ];
    const registrations = [
      makeRegistration({ qualifiedId: 'test-app.analytics:main', singleton: true }),
      makeRegistration({ qualifiedId: 'test-app.monitor:main', singleton: true }),
    ];

    const items = buildTrayMenuTemplate(windows, trayEntries, registrations);

    // Dashboard first
    expect(items[0]).toMatchObject({ label: 'Dashboard', type: 'normal' });
    // Separator after Dashboard (because windows/entries exist)
    expect(items[1]).toMatchObject({ type: 'separator' });
    // Live window items
    expect(items[2]).toMatchObject({ label: 'Acme Workspace', type: 'normal' });
    expect(items[3]).toMatchObject({ label: 'Fix auth bug', type: 'normal' });
    // Separator between windows and launchers
    expect(items[4]).toMatchObject({ type: 'separator' });
    // Launcher entries (no callbacks → action undefined)
    expect(items[5]).toMatchObject({ label: 'Analytics', type: 'normal', action: undefined });
    expect(items[6]).toMatchObject({ label: 'Monitor', type: 'normal', action: undefined });
    // Final separator + Quit
    expect(items[7]).toMatchObject({ type: 'separator' });
    expect(items[8]).toMatchObject({ label: 'Quit', type: 'normal' });
  });

  it('routes launcher entries through item-clicked actions even when singleton windows already exist', () => {
    const windows = [makeWindow({ windowId: 21, registrationId: 'test-app.monitor:main', label: 'Existing Monitor' })];
    const trayEntries = [makeWindowTrayEntry('Monitor', 'test-app.monitor:main')];
    const registrations = [makeRegistration({ qualifiedId: 'test-app.monitor:main', singleton: true })];

    const items = buildTrayMenuTemplate(windows, trayEntries, registrations, {
      focusWindow: vi.fn(),
      createWindow: vi.fn(),
      onItemClicked: vi.fn(),
      openDashboard: vi.fn(),
    });

    expect(findMenuItem('Monitor', items)).toMatchObject({ action: 'item-clicked-test-app.monitor:main' });
  });

  it('delegates open-dashboard to the openDashboard callback', () => {
    const deps = makeTrayDeps();

    handleTrayAction('open-dashboard', deps);

    expect(deps.openDashboard).toHaveBeenCalledOnce();
    expect(deps.onQuit).not.toHaveBeenCalled();
  });

  it('delegates quit to the composition root lifecycle', () => {
    const deps = makeTrayDeps();

    handleTrayAction('quit', deps);

    expect(deps.onQuit).toHaveBeenCalledOnce();
    expect(deps.openDashboard).not.toHaveBeenCalled();
  });

  it('delegates toggle-auto-launch to the composition root toggle callback', () => {
    const deps = makeTrayDeps({ autoLaunchEnabled: false });

    handleTrayAction('toggle-auto-launch', deps);

    expect(deps.toggleAutoLaunch).toHaveBeenCalledOnce();
    expect(deps.openDashboard).not.toHaveBeenCalled();
    expect(deps.onQuit).not.toHaveBeenCalled();
  });

  it('emits item click before creating a new window for launcher entries', () => {
    const trayEntries = [makeWindowTrayEntry('Editor', 'test-app.editor:main')];
    const registrations = [makeRegistration({ qualifiedId: 'test-app.editor:main', singleton: false })];
    const deps = makeTrayDeps({
      getEntries: () => trayEntries,
      listRegistrations: () => registrations,
    });

    handleTrayAction('item-clicked-test-app.editor:main', deps);

    expect(deps.onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
    expect(deps.createWindow).toHaveBeenCalledWith('test-app.editor:main');
    expectCalledBefore(vi.mocked(deps.onItemClicked), vi.mocked(deps.createWindow));
    expect(deps.focusWindow).not.toHaveBeenCalled();
  });

  it('emits item click before focusing an existing singleton window', () => {
    const trayEntries = [makeWindowTrayEntry('Monitor', 'test-app.monitor:main')];
    const registrations = [makeRegistration({ qualifiedId: 'test-app.monitor:main', singleton: true })];
    const windows = [makeWindow({ windowId: 21, registrationId: 'test-app.monitor:main', label: 'Existing Monitor' })];
    const deps = makeTrayDeps({
      getEntries: () => trayEntries,
      listRegistrations: () => registrations,
      listWindows: () => windows,
    });

    handleTrayAction('item-clicked-test-app.monitor:main', deps);

    expect(deps.onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
    expect(deps.focusWindow).toHaveBeenCalledWith(21);
    expectCalledBefore(vi.mocked(deps.onItemClicked), vi.mocked(deps.focusWindow));
    expect(deps.createWindow).not.toHaveBeenCalled();
  });
});

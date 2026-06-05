import { describe, expect, it, vi } from 'vitest';
import type { TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import type { WindowState } from '@makaio/host-shared';
import type { WindowRegistration } from '@makaio/kernel';
import { buildTrayMenuTemplate } from '../src/main/tray-menu-template.js';

function makeWindow(overrides: Partial<WindowState> & { windowId: number; registrationId: string }): WindowState {
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
  const item = items.find((candidate) => candidate.label === label);
  expect(item).toBeDefined();
  return item;
}

/**
 * Projects the menu into the user-visible order contract asserted by these tests.
 * @param items - Tray template returned by `buildTrayMenuTemplate`.
 * @returns Sequence of labels and separators as rendered to the user.
 */
function projectMenuShape(items: ReturnType<typeof buildTrayMenuTemplate>): string[] {
  return items.reduce<string[]>((shape, item) => {
    const token = item.label ?? item.type;
    if (token !== undefined) {
      shape.push(token);
    }
    return shape;
  }, []);
}

describe('buildTrayMenuTemplate', () => {
  it('Dashboard entry is always first, followed by separator, then live windows, then launchers', () => {
    const windows: WindowState[] = [
      makeWindow({
        windowId: 1,
        registrationId: 'test-app.editor:main',
        label: 'Acme Workspace',
        params: { projectId: 'p1' },
        focused: true,
      }),
      makeWindow({
        windowId: 3,
        registrationId: 'test-app.editor:main',
        label: 'Fix auth bug',
        params: { sessionId: 's3' },
      }),
    ];
    const trayEntries: TrayMenuListEntry[] = [
      makeWindowTrayEntry('Dashboard Launcher', 'test-app.dashboard:main'),
      makeWindowTrayEntry('Monitor', 'test-app.monitor:main'),
    ];
    const registrations = [
      makeRegistration({ qualifiedId: 'test-app.dashboard:main', singleton: true }),
      makeRegistration({ qualifiedId: 'test-app.monitor:main', singleton: true }),
    ];

    const items = buildTrayMenuTemplate(windows, trayEntries, registrations);

    expect(projectMenuShape(items)).toEqual([
      'Dashboard',
      'separator',
      'Acme Workspace',
      'Fix auth bug',
      'separator',
      'Dashboard Launcher',
      'Monitor',
      'separator',
      'Quit',
    ]);
  });

  it('shows Dashboard + separator + Quit when no windows or launcher entries exist', () => {
    const items = buildTrayMenuTemplate([], [], []);

    // Dashboard is always present; no live windows or launchers so no
    // post-Dashboard separator; final separator + Quit always added.
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ label: 'Dashboard', type: 'normal' });
    expect(items[1]).toMatchObject({ type: 'separator' });
    expect(items[2]).toMatchObject({ label: 'Quit', role: 'quit' });
  });

  it('always ends with separator + Quit when entries exist', () => {
    const items = buildTrayMenuTemplate([], [makeTrayEntry('Tool', 'tool', 'tools')], []);
    const last = items[items.length - 1];
    const secondLast = items[items.length - 2];

    expect(last).toMatchObject({ label: 'Quit', role: 'quit' });
    expect(secondLast).toMatchObject({ type: 'separator' });
  });

  it('shows Dashboard + separator + live window + separator + Quit when no launcher entries exist', () => {
    const windows = [makeWindow({ windowId: 1, registrationId: 'test-app.editor:main', label: 'My Project' })];
    const items = buildTrayMenuTemplate(windows, [], []);

    // Dashboard (framework-owned) + separator (window exists) + live window
    // + final separator + quit. No window/launcher separator because there
    // are no launcher entries.
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ label: 'Dashboard', type: 'normal' });
    expect(items[1]).toMatchObject({ type: 'separator' });
    expect(items[2]).toMatchObject({ label: 'My Project' });
    expect(items[3]).toMatchObject({ type: 'separator' });
    expect(items[4]).toMatchObject({ label: 'Quit' });
  });

  it('creates a new window via launcher when no matching window is open', () => {
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const trayEntries = [makeWindowTrayEntry('Editor', 'test-app.editor:main')];
    const registrations = [makeRegistration({ qualifiedId: 'test-app.editor:main', singleton: false })];
    const onItemClicked = vi.fn();

    const items = buildTrayMenuTemplate(
      [makeWindow({ windowId: 8, registrationId: 'test-app.dashboard:main', params: undefined })],
      trayEntries,
      registrations,
      { focusWindow, createWindow, onItemClicked, openDashboard: vi.fn() },
    );

    findMenuItem('Editor', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(createWindow).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith('test-app.editor:main');
    expect(focusWindow).not.toHaveBeenCalled();
    expect(onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
  });

  it('focuses an existing singleton window from its launcher item', () => {
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const onItemClicked = vi.fn();
    const trayEntries = [makeWindowTrayEntry('Monitor', 'test-app.monitor:main')];
    const registrations = [makeRegistration({ qualifiedId: 'test-app.monitor:main', singleton: true })];
    const windows = [
      makeWindow({
        windowId: 21,
        registrationId: 'test-app.monitor:main',
        label: 'Existing Monitor',
      }),
    ];

    const items = buildTrayMenuTemplate(windows, trayEntries, registrations, {
      focusWindow,
      createWindow,
      onItemClicked,
      openDashboard: vi.fn(),
    });

    findMenuItem('Monitor', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(focusWindow).toHaveBeenCalledOnce();
    expect(focusWindow).toHaveBeenCalledWith(21);
    expect(createWindow).not.toHaveBeenCalled();
    expect(onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
  });

  it('groups tray entries by section with separators between groups, after the framework Dashboard entry', () => {
    const trayEntries: TrayMenuListEntry[] = [
      makeTrayEntry('Dashboard Launcher', 'test-app.dashboard:main', 'utilities'),
      makeTrayEntry('Editor', 'test-app.editor:main', 'tools'),
      makeTrayEntry('Dashboard View', 'dashboard:main', 'views'),
    ];

    const items = buildTrayMenuTemplate([], trayEntries, [], undefined);

    // Framework Dashboard entry (always first)
    // separator (entries exist, so hasSubsequentItems = true)
    // utilities group: Dashboard Launcher
    // separator
    // tools group: Editor
    // separator
    // views group: Dashboard View
    // separator (quit separator)
    // Quit
    expect(projectMenuShape(items)).toEqual([
      'Dashboard',
      'separator',
      'Dashboard Launcher',
      'separator',
      'Editor',
      'separator',
      'Dashboard View',
      'separator',
      'Quit',
    ]);
  });

  it('emits item click for action-only entries', () => {
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const onItemClicked = vi.fn();
    const trayEntries = [makeTrayEntry('Switch Auth', 'switch-auth', 'utilities', { action: 'test.tray.action' })];

    const items = buildTrayMenuTemplate([], trayEntries, [], {
      focusWindow,
      createWindow,
      onItemClicked,
      openDashboard: vi.fn(),
    });

    findMenuItem('Switch Auth', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(onItemClicked).toHaveBeenCalledOnce();
    expect(onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('emits item click and uses the registrationId shortcut for window entries', () => {
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const onItemClicked = vi.fn();
    const trayEntries = [makeWindowTrayEntry('Monitor', 'test-app.monitor:main')];
    const registrations = [makeRegistration({ qualifiedId: 'test-app.monitor:main', singleton: false })];

    const items = buildTrayMenuTemplate([], trayEntries, registrations, {
      focusWindow,
      createWindow,
      onItemClicked,
      openDashboard: vi.fn(),
    });

    findMenuItem('Monitor', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
    expect(createWindow).toHaveBeenCalledWith('test-app.monitor:main');
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it('emits item click for entries without metadata', () => {
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const onItemClicked = vi.fn();
    const trayEntries = [makeTrayEntry('Plain Action', 'plain-action')];

    const items = buildTrayMenuTemplate([], trayEntries, [], {
      focusWindow,
      createWindow,
      onItemClicked,
      openDashboard: vi.fn(),
    });

    findMenuItem('Plain Action', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('emits item click with groupId for entries that belong to a group', () => {
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const onItemClicked = vi.fn();
    const trayEntries: TrayMenuListEntry[] = [
      {
        ...makeTrayEntry('Group Action', 'group-action', 'utilities', { action: 'some.action' }),
        groupId: 'my-group',
      },
    ];

    const items = buildTrayMenuTemplate([], trayEntries, [], {
      focusWindow,
      createWindow,
      onItemClicked,
      openDashboard: vi.fn(),
    });

    findMenuItem('Group Action', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(onItemClicked).toHaveBeenCalledOnce();
    expect(onItemClicked).toHaveBeenCalledWith(trayEntries[0]);
    expect(focusWindow).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('Dashboard entry is always present at index 0 regardless of windows or entries', () => {
    const allCombinations: Array<[WindowState[], TrayMenuListEntry[]]> = [
      [[], []],
      [[makeWindow({ windowId: 1, registrationId: 'x:main' })], []],
      [[], [makeTrayEntry('Tool', 'tool', 'tools')]],
      [[makeWindow({ windowId: 2, registrationId: 'y:main' })], [makeTrayEntry('Tool', 'tool', 'tools')]],
    ];

    for (const [windows, entries] of allCombinations) {
      const items = buildTrayMenuTemplate(windows, entries, []);
      expect(items[0]).toMatchObject({ label: 'Dashboard', type: 'normal' });
    }
  });

  it('Dashboard entry click invokes the openDashboard callback', () => {
    const openDashboard = vi.fn();
    const focusWindow = vi.fn();
    const createWindow = vi.fn();
    const onItemClicked = vi.fn();

    const items = buildTrayMenuTemplate([], [], [], {
      focusWindow,
      createWindow,
      onItemClicked,
      openDashboard,
    });

    findMenuItem('Dashboard', items)?.click?.(undefined as never, undefined as never, undefined as never);

    expect(openDashboard).toHaveBeenCalledOnce();
    expect(focusWindow).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
    expect(onItemClicked).not.toHaveBeenCalled();
  });

  it('Dashboard entry click is a no-op when openDashboard callback is not provided', () => {
    // When callbacks are omitted (pure template build for testing), the click
    // handler is undefined and clicking does not throw.
    const items = buildTrayMenuTemplate([], [], []);
    expect(() => {
      items[0].click?.(undefined as never, undefined as never, undefined as never);
    }).not.toThrow();
  });
});

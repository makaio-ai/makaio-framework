import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBusInstance, RequestError, type IMakaioBus } from '@makaio/bus-core';
import { type TrayMenuEntry, type TrayMenuGroup } from '../schemas.js';
import { TrayMenuSubjects } from '../namespace.js';
import { TrayMenuService } from '../tray-menu-service.js';

function makeEntry(overrides: Partial<TrayMenuEntry> & { entryId: string; label: string }): TrayMenuEntry {
  return {
    packageName: 'pkg',
    section: 'utilities',
    priority: 50,
    enabled: true,
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<TrayMenuGroup> & { groupId: string; entries: TrayMenuGroup['entries'] },
): TrayMenuGroup {
  return {
    packageName: 'pkg',
    section: 'utilities',
    priority: 50,
    ...overrides,
  };
}

describe('TrayMenuService', () => {
  let bus: IMakaioBus;
  let service: TrayMenuService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new TrayMenuService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('registers an entry, lists it, and emits changed', async () => {
    let changedCount = 0;
    const cleanup = bus.on(TrayMenuSubjects.changed, () => {
      changedCount += 1;
    });

    const entry = makeEntry({ entryId: 'settings', label: 'Settings' });
    const result = await bus.request(TrayMenuSubjects.register, { entry });
    const listed = await bus.request(TrayMenuSubjects.list, {});

    cleanup();
    expect(result).toEqual({ entryId: 'settings' });
    expect(listed.entries).toEqual([entry]);
    expect(changedCount).toBe(1);
  });

  it('applies schema defaults during registration', async () => {
    await bus.request(TrayMenuSubjects.register, {
      entry: {
        packageName: 'pkg',
        entryId: 'settings',
        label: 'Settings',
        section: 'utilities',
      },
    });
    await bus.request(TrayMenuSubjects.group.register, {
      group: {
        packageName: 'pkg',
        groupId: 'windows',
        section: 'views',
        entries: [{ entryId: 'main', label: 'Main' }],
      },
    });

    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(listed.entries).toEqual([
      {
        packageName: 'pkg',
        entryId: 'settings',
        label: 'Settings',
        section: 'utilities',
        priority: 50,
        enabled: true,
      },
      {
        packageName: 'pkg',
        entryId: 'main',
        label: 'Main',
        section: 'views',
        priority: 50,
        enabled: true,
        groupId: 'windows',
      },
    ]);
  });

  it('replaces an existing entry with the same packageName and entryId', async () => {
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'settings', label: 'Settings', enabled: true }),
    });
    const replacement = makeEntry({ entryId: 'settings', label: 'Preferences', enabled: false });

    await bus.request(TrayMenuSubjects.register, { entry: replacement });
    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(listed.entries).toEqual([replacement]);
  });

  it('unregisters an existing entry and emits changed', async () => {
    let changedCount = 0;
    const cleanup = bus.on(TrayMenuSubjects.changed, () => {
      changedCount += 1;
    });
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'settings', label: 'Settings' }),
    });

    const result = await bus.request(TrayMenuSubjects.unregister, { packageName: 'pkg', entryId: 'settings' });
    const listed = await bus.request(TrayMenuSubjects.list, {});

    cleanup();
    expect(result).toEqual({ removed: true });
    expect(listed.entries).toEqual([]);
    expect(changedCount).toBe(2);
  });

  it('does not emit changed when unregistering a missing entry', async () => {
    let changedCount = 0;
    const cleanup = bus.on(TrayMenuSubjects.changed, () => {
      changedCount += 1;
    });

    const result = await bus.request(TrayMenuSubjects.unregister, { packageName: 'pkg', entryId: 'missing' });

    cleanup();
    expect(result).toEqual({ removed: false });
    expect(changedCount).toBe(0);
  });

  it('registers a group and lists its entries in declared order', async () => {
    const group = makeGroup({
      groupId: 'windows',
      section: 'views',
      priority: 20,
      entries: [
        { entryId: 'alpha', label: 'Alpha', priority: 90, enabled: true },
        { entryId: 'beta', label: 'Beta', priority: 10, enabled: true },
      ],
    });

    const result = await bus.request(TrayMenuSubjects.group.register, { group });
    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(result).toEqual({ groupId: 'windows' });
    expect(listed.entries.map((entry) => entry.entryId)).toEqual(['alpha', 'beta']);
    expect(listed.entries).toEqual([
      { ...group.entries[0], packageName: 'pkg', section: 'views', groupId: 'windows' },
      { ...group.entries[1], packageName: 'pkg', section: 'views', groupId: 'windows' },
    ]);
  });

  it('replaces a group atomically with the same packageName and groupId', async () => {
    await bus.request(TrayMenuSubjects.group.register, {
      group: makeGroup({
        groupId: 'windows',
        entries: [{ entryId: 'alpha', label: 'Alpha', priority: 50, enabled: true }],
      }),
    });
    const replacement = makeGroup({
      groupId: 'windows',
      entries: [
        { entryId: 'beta', label: 'Beta', priority: 50, enabled: true },
        { entryId: 'gamma', label: 'Gamma', priority: 50, enabled: true },
      ],
    });

    await bus.request(TrayMenuSubjects.group.register, { group: replacement });
    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(listed.entries.map((entry) => entry.entryId)).toEqual(['beta', 'gamma']);
  });

  it('unregisters a group and removes its entries', async () => {
    await bus.request(TrayMenuSubjects.group.register, {
      group: makeGroup({
        groupId: 'windows',
        entries: [{ entryId: 'alpha', label: 'Alpha', priority: 50, enabled: true }],
      }),
    });

    const result = await bus.request(TrayMenuSubjects.group.unregister, { packageName: 'pkg', groupId: 'windows' });
    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(result).toEqual({ removed: true });
    expect(listed.entries).toEqual([]);
  });

  it('rejects a standalone entry when the entryId already exists in a group for the package', async () => {
    await bus.request(TrayMenuSubjects.group.register, {
      group: makeGroup({
        groupId: 'windows',
        entries: [{ entryId: 'alpha', label: 'Alpha', priority: 50, enabled: true }],
      }),
    });

    let error: unknown;
    try {
      await bus.request(TrayMenuSubjects.register, {
        entry: makeEntry({ entryId: 'alpha', label: 'Alpha' }),
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(RequestError);
    expect(error instanceof RequestError ? error.cause?.message : '').toContain('already exists in a group');
  });

  it('sorts entries by section, priority, then label', async () => {
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'view', label: 'View', section: 'views', priority: 1 }),
    });
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'zebra', label: 'Zebra', section: 'utilities', priority: 2 }),
    });
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'alpha', label: 'Alpha', section: 'utilities', priority: 2 }),
    });
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'tool', label: 'Tool', section: 'tools', priority: 1 }),
    });

    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(listed.entries.map((entry) => entry.entryId)).toEqual(['alpha', 'zebra', 'tool', 'view']);
  });

  it('rejects a group with duplicate entryIds within the same group', async () => {
    let error: unknown;
    try {
      await bus.request(TrayMenuSubjects.group.register, {
        group: makeGroup({
          groupId: 'dupes',
          entries: [
            { entryId: 'alpha', label: 'Alpha', priority: 50, enabled: true },
            { entryId: 'alpha', label: 'Alpha Dupe', priority: 50, enabled: true },
          ],
        }),
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(RequestError);
    expect(error instanceof RequestError ? error.cause?.message : '').toContain('contains duplicate entry');
  });

  it('rejects a group whose entryId already exists in another group for the same package', async () => {
    await bus.request(TrayMenuSubjects.group.register, {
      group: makeGroup({
        groupId: 'group-a',
        entries: [{ entryId: 'alpha', label: 'Alpha', priority: 50, enabled: true }],
      }),
    });

    let error: unknown;
    try {
      await bus.request(TrayMenuSubjects.group.register, {
        group: makeGroup({
          groupId: 'group-b',
          entries: [{ entryId: 'alpha', label: 'Alpha', priority: 50, enabled: true }],
        }),
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(RequestError);
    expect(error instanceof RequestError ? error.cause?.message : '').toContain('already exists in another group');
  });

  it('lists mixed standalone and group entries while keeping group entries adjacent', async () => {
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'solo-a', label: 'Solo A', section: 'utilities', priority: 10 }),
    });
    await bus.request(TrayMenuSubjects.group.register, {
      group: makeGroup({
        groupId: 'group',
        section: 'utilities',
        priority: 20,
        entries: [
          { entryId: 'group-b', label: 'Group B', priority: 1, enabled: true },
          { entryId: 'group-a', label: 'Group A', priority: 0, enabled: true },
        ],
      }),
    });
    await bus.request(TrayMenuSubjects.register, {
      entry: makeEntry({ entryId: 'solo-z', label: 'Solo Z', section: 'utilities', priority: 30 }),
    });

    const listed = await bus.request(TrayMenuSubjects.list, {});

    expect(listed.entries.map((entry) => entry.entryId)).toEqual(['solo-a', 'group-b', 'group-a', 'solo-z']);
  });
});

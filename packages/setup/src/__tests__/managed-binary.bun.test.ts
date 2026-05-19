import { describe, expect, it } from 'bun:test';
import { recommendManagedAction, buildManagedBinaryStates } from '../detect/managed-binary.js';
import type { SetupClientBinaryInventory, SetupClientEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInventory(overrides: Partial<SetupClientBinaryInventory> = {}): SetupClientBinaryInventory {
  return {
    clientId: 'test-client',
    installedVersions: [],
    activeVersion: null,
    pinnedVersion: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SetupClientEntry> = {}): SetupClientEntry {
  return {
    clientId: 'test-client',
    displayName: 'Test Client',
    binaryName: 'test-bin',
    detectPaths: [],
    extensionPackages: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// recommendManagedAction
// ---------------------------------------------------------------------------

describe('recommendManagedAction', () => {
  it('returns global-only when managed is null', () => {
    expect(recommendManagedAction(null)).toBe('global-only');
  });

  it('returns managed-active when activeVersion equals pinnedVersion (both non-null)', () => {
    const managed = makeInventory({
      activeVersion: '1.2.3',
      pinnedVersion: '1.2.3',
      installedVersions: ['1.2.3'],
    });
    expect(recommendManagedAction(managed)).toBe('managed-active');
  });

  it('returns activate-installed-pin when pin is in installedVersions but not active', () => {
    const managed = makeInventory({
      activeVersion: '1.0.0',
      pinnedVersion: '2.0.0',
      installedVersions: ['1.0.0', '2.0.0'],
    });
    expect(recommendManagedAction(managed)).toBe('activate-installed-pin');
  });

  it('returns install-and-activate-pin when pin is not in installedVersions', () => {
    const managed = makeInventory({
      activeVersion: '1.0.0',
      pinnedVersion: '3.0.0',
      installedVersions: ['1.0.0', '2.0.0'],
    });
    expect(recommendManagedAction(managed)).toBe('install-and-activate-pin');
  });

  it('returns install-and-activate-pin when activeVersion is null and pin not installed', () => {
    const managed = makeInventory({
      activeVersion: null,
      pinnedVersion: '1.0.0',
      installedVersions: [],
    });
    expect(recommendManagedAction(managed)).toBe('install-and-activate-pin');
  });

  it('returns activate-installed-pin when activeVersion is null and pin is installed', () => {
    const managed = makeInventory({
      activeVersion: null,
      pinnedVersion: '1.0.0',
      installedVersions: ['1.0.0'],
    });
    expect(recommendManagedAction(managed)).toBe('activate-installed-pin');
  });

  it('returns global-only when both activeVersion and pinnedVersion are null', () => {
    const managed = makeInventory({
      activeVersion: null,
      pinnedVersion: null,
      installedVersions: [],
    });
    expect(recommendManagedAction(managed)).toBe('global-only');
  });
});

// ---------------------------------------------------------------------------
// buildManagedBinaryStates
// ---------------------------------------------------------------------------

describe('buildManagedBinaryStates', () => {
  it('maps catalog entries to managed-active states when active equals pin', () => {
    const catalog: SetupClientEntry[] = [makeEntry({ clientId: 'client-a', binaryName: 'bin-a' })];
    const managedClients = new Map<string, SetupClientBinaryInventory>([
      [
        'client-a',
        makeInventory({
          clientId: 'client-a',
          activeVersion: '2.0.0',
          pinnedVersion: '2.0.0',
          installedVersions: ['2.0.0'],
        }),
      ],
    ]);

    const states = buildManagedBinaryStates({
      catalog,
      globalResults: new Map(),
      managedClients,
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({
      clientId: 'client-a',
      binaryName: 'bin-a',
      recommendation: 'managed-active',
      activeVersion: '2.0.0',
      pinnedVersion: '2.0.0',
    });
  });

  it('produces global-only for clients with no managed entry', () => {
    const catalog: SetupClientEntry[] = [makeEntry({ clientId: 'global-client', binaryName: 'global-bin' })];

    const states = buildManagedBinaryStates({
      catalog,
      globalResults: new Map([['global-client', '1.0.0']]),
      managedClients: new Map(),
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({
      clientId: 'global-client',
      binaryName: 'global-bin',
      recommendation: 'global-only',
      activeVersion: null,
      pinnedVersion: null,
    });
  });

  it('maps multiple catalog entries with mixed states', () => {
    const catalog: SetupClientEntry[] = [
      makeEntry({ clientId: 'client-a', binaryName: 'bin-a' }),
      makeEntry({ clientId: 'client-b', binaryName: 'bin-b' }),
      makeEntry({ clientId: 'client-c', binaryName: 'bin-c' }),
    ];
    const managedClients = new Map<string, SetupClientBinaryInventory>([
      [
        'client-a',
        makeInventory({
          clientId: 'client-a',
          activeVersion: '1.0.0',
          pinnedVersion: '1.0.0',
          installedVersions: ['1.0.0'],
        }),
      ],
      [
        'client-b',
        makeInventory({
          clientId: 'client-b',
          activeVersion: null,
          pinnedVersion: '2.0.0',
          installedVersions: ['2.0.0'],
        }),
      ],
      // client-c has no managed entry → global-only
    ]);

    const states = buildManagedBinaryStates({
      catalog,
      globalResults: new Map(),
      managedClients,
    });

    expect(states).toHaveLength(3);
    expect(states[0]?.recommendation).toBe('managed-active');
    expect(states[1]?.recommendation).toBe('activate-installed-pin');
    expect(states[2]?.recommendation).toBe('global-only');
  });

  it('preserves activeVersion and pinnedVersion from managed inventory', () => {
    const catalog: SetupClientEntry[] = [makeEntry({ clientId: 'client-x', binaryName: 'bin-x' })];
    const managedClients = new Map<string, SetupClientBinaryInventory>([
      [
        'client-x',
        makeInventory({
          clientId: 'client-x',
          activeVersion: '0.9.0',
          pinnedVersion: '1.5.0',
          installedVersions: ['0.9.0'],
        }),
      ],
    ]);

    const states = buildManagedBinaryStates({
      catalog,
      globalResults: new Map(),
      managedClients,
    });

    expect(states[0]?.activeVersion).toBe('0.9.0');
    expect(states[0]?.pinnedVersion).toBe('1.5.0');
    expect(states[0]?.recommendation).toBe('install-and-activate-pin');
  });

  it('returns empty array for empty catalog', () => {
    const states = buildManagedBinaryStates({
      catalog: [],
      globalResults: new Map(),
      managedClients: new Map(),
    });
    expect(states).toEqual([]);
  });
});

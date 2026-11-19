import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { OpenContributionReader } from '@makaio/contracts';
import { BaseService } from '@makaio/service-base';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { ExtensionContextBase, KernelMakaioExtension as MakaioExtension } from '../extension/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal service so a test extension has something to create. */
class NoopService extends BaseService {
  /**
   * @param bus - Bus instance forwarded to BaseService.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {}

  protected async onDestroy(): Promise<void> {}
}

/**
 * Minimal {@link ExtensionContextBase} fields (excluding coordinator-owned and
 * bus-owned fields) for test coordinators.
 */
const TEST_PKG_CTX_BASE: ExtensionContextBase = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};

/** Readers captured from the contexts the coordinator hands to `create`, keyed by extension name. */
type ReaderRegistry = Map<string, OpenContributionReader>;

/**
 * Build a test extension that records the reader of its context.
 * @param readers - Registry the extension writes its reader into.
 * @param name - Extension name.
 * @param openContributions - Entries the extension contributes, keyed by kind.
 * @returns A manifest for the real coordinator.
 */
function extension(
  readers: ReaderRegistry,
  name: string,
  openContributions?: Record<string, unknown[]>,
): MakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    ...(openContributions === undefined ? {} : { openContributions }),
    create: (ctx) => {
      readers.set(name, ctx.openContributions);
      return new NoopService(ctx.bus);
    },
  };
}

/**
 * Create a real coordinator over a fresh bus.
 * @returns The coordinator.
 */
function createCoordinator(): ExtensionCoordinator {
  return new ExtensionCoordinator(createBusInstance(), { extensionContextBase: TEST_PKG_CTX_BASE });
}

/**
 * Look up a captured reader.
 * @param readers - Registry filled by the test extensions.
 * @param name - Extension name.
 * @returns The reader of that extension.
 */
function readerOf(readers: ReaderRegistry, name: string): OpenContributionReader {
  const reader = readers.get(name);
  if (reader === undefined) throw new Error(`no reader captured for '${name}'`);
  return reader;
}

/**
 * Collect the kinds the coordinator warned about through `console.warn`.
 * @param warn - Spy installed on `console.warn`.
 * @returns Kinds named by open-contribution warnings, in call order.
 */
function warnedKinds(warn: { mock: { calls: unknown[][] } }): unknown[] {
  return warn.mock.calls
    .filter(([format]) => typeof format === 'string' && format.includes('Open contribution kind'))
    .map(([, kind]) => kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtensionCoordinator open contributions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets the owner read the entries of every contributor in activation order', async () => {
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([
      extension(readers, 'acme.host'),
      extension(readers, 'beta.pack', { 'acme.host.widgets': [{ id: 'one' }, { id: 'two' }] }),
    ]);

    await coordinator.startAll();

    expect(readerOf(readers, 'acme.host').of('acme.host.widgets')).toEqual([
      { extension: 'beta.pack', entries: [{ id: 'one' }, { id: 'two' }] },
    ]);
  });

  it('throws when an extension reads a kind it does not own', async () => {
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([
      extension(readers, 'acme.host'),
      extension(readers, 'beta.pack', { 'acme.host.widgets': [{ id: 'one' }] }),
    ]);

    await coordinator.startAll();

    expect(() => readerOf(readers, 'beta.pack').of('acme.host.widgets')).toThrow(
      "Extension 'beta.pack' does not own contribution kind 'acme.host.widgets'",
    );
  });

  it('fails activation of an extension whose key has no owner', async () => {
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([extension(readers, 'beta.pack', { widgets: [{ id: 'one' }] })]);

    await coordinator.startAll();

    const info = coordinator.list().find((entry) => entry.name === 'beta.pack');
    expect(info?.state).toBe('failed');
    expect(info?.error).toContain(
      "Open contribution kind 'widgets' of extension 'beta.pack' is not a contribution name",
    );
  });

  it('fails activation of an extension whose slot is null', async () => {
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    const slot = JSON.parse('null');
    coordinator.load([extension(readers, 'beta.pack', slot)]);

    await coordinator.startAll();

    const info = coordinator.list().find((entry) => entry.name === 'beta.pack');
    expect(info?.state).toBe('failed');
    expect(info?.error).toContain(
      "Open contributions of extension 'beta.pack' must be an object keyed by contribution name",
    );
  });

  it('removes the entries of a stopped contributor from a new read', async () => {
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([
      extension(readers, 'acme.host'),
      extension(readers, 'beta.pack', { 'acme.host.widgets': [{ id: 'one' }] }),
    ]);
    await coordinator.startAll();
    const host = readerOf(readers, 'acme.host');
    const before = host.of('acme.host.widgets');

    await coordinator.applyExtensionTransition('beta.pack', false);

    expect(host.of('acme.host.widgets')).toEqual([]);
    // The earlier result is a frozen copy and does not change retroactively.
    expect(before).toHaveLength(1);
  });

  it('warns once per kind whose owner is not active and not for a kind with an active owner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([
      extension(readers, 'acme.host'),
      extension(readers, 'beta.pack', {
        'acme.host.widgets': [{ id: 'one' }],
        'gamma.missing.panels': [{ id: 'two' }],
      }),
      extension(readers, 'delta.pack', { 'gamma.missing.panels': [{ id: 'three' }] }),
    ]);

    await coordinator.startAll();

    expect(warnedKinds(warn)).toEqual(['gamma.missing.panels']);
  });

  it('does not warn when every kind has an active owner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([
      extension(readers, 'acme.host'),
      extension(readers, 'beta.pack', { 'acme.host.widgets': [{ id: 'one' }] }),
    ]);

    await coordinator.startAll();

    expect(warnedKinds(warn)).toEqual([]);
  });

  // PINS TODAY'S BEHAVIOUR. This is an open design question (FACT-383: extension `a` next to
  // `a.b`, the rule is undecided), not an endorsement: owners may contain dots, so `acme.` is a prefix of `acme.host.widgets`
  // and `acme` may read a kind that `acme.host` declares. Resolving it needs the set of all extension
  // names or a rule for extension names.
  it('lets extension `acme` read a kind of extension `acme.host` because `acme.` is a prefix (open design question)', async () => {
    const readers: ReaderRegistry = new Map();
    const coordinator = createCoordinator();
    coordinator.load([
      extension(readers, 'acme'),
      extension(readers, 'acme.host'),
      extension(readers, 'beta.pack', { 'acme.host.widgets': [{ id: 'one' }] }),
    ]);

    await coordinator.startAll();

    const expected = [{ extension: 'beta.pack', entries: [{ id: 'one' }] }];
    expect(readerOf(readers, 'acme.host').of('acme.host.widgets')).toEqual(expected);
    expect(readerOf(readers, 'acme').of('acme.host.widgets')).toEqual(expected);
  });
});

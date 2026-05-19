import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ExtensionEntrypoints } from '@makaio/contracts';
import type { DiscoveredExtension } from '../extension-discovery.js';
import { synthesizeBrowserOnlyPackages } from '../synthesize-browser-only-packages.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid {@link DiscoveredExtension} fixture for browser-only extensions.
 * @param name - Extension name.
 * @param browserEntry - Optional convention-based browser entrypoint stem (`true` or a custom stem string).
 * @param serverEntry - Optional convention-based server entrypoint stem (`true` or a custom stem string).
 * @param extensionPath - Absolute path to the extension root.
 * @param configDefaults - Optional descriptor config defaults.
 */
const makeDiscovered = (
  name: string,
  browserEntry?: true | string,
  serverEntry?: true | string,
  extensionPath?: string,
  configDefaults?: Record<string, unknown>,
): DiscoveredExtension => {
  const descriptor: DiscoveredExtension['descriptor'] = {
    name,
    displayName: `${name} Display`,
    version: '1.0.0',
    makaio: { framework: '>=2.0.0' },
    entrypoints: {
      ...(serverEntry !== undefined ? { server: serverEntry } : {}),
      ...(browserEntry !== undefined ? { browser: browserEntry } : {}),
    },
    ...(configDefaults !== undefined ? { config: { defaults: configDefaults } } : {}),
  };

  return {
    descriptor,
    extensionPath: extensionPath ?? createExtensionRoot(name, descriptor.entrypoints),
    source: 'local',
  };
};

let fixtureRoot: string | undefined;

/**
 * Create a real extension root with production browser candidate files.
 * @param name - Extension name used for the fixture directory.
 * @param entrypoints - Descriptor entrypoint declarations to materialize.
 * @returns Absolute extension fixture root.
 */
function createExtensionRoot(name: string, entrypoints: ExtensionEntrypoints): string {
  if (fixtureRoot === undefined) {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-synthesize-browser-'));
  }

  const extensionPath = fs.mkdtempSync(path.join(fixtureRoot, `${name}-`));
  const browser = entrypoints.browser;
  if (browser !== undefined) {
    const stem = browser === true ? 'browser' : browser;
    const candidatePath = path.join(extensionPath, 'dist', `${stem}.mjs`);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, 'export default {};\n');
  }

  return extensionPath;
}

/**
 * A no-op mount factory that records calls for assertion.
 * @param calls - Array to push recorded call arguments into.
 * @returns A `createMount` function that pushes `[serveRoot, urlPrefix]` on each call.
 */
const makeMountSpy = (calls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }>) => {
  return (serveRoot: string, urlPrefix: string): ((app: unknown) => void) => {
    const mountCalls: unknown[] = [];
    calls.push({ serveRoot, urlPrefix, mountCalls });
    return (app: unknown) => {
      mountCalls.push(app);
    };
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synthesizeBrowserOnlyPackages', () => {
  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-synthesize-browser-'));
  });

  afterEach(() => {
    if (fixtureRoot !== undefined) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('returns empty packages and empty configDefaults when discovered list is empty', () => {
    const result = synthesizeBrowserOnlyPackages([]);
    expect(result.packages).toStrictEqual([]);
    expect(result.configDefaults.size).toBe(0);
  });

  it('returns empty packages when descriptor has neither server nor browser entry', () => {
    const discovered = makeDiscovered('no-entries');
    const result = synthesizeBrowserOnlyPackages([discovered]);
    expect(result.packages).toStrictEqual([]);
  });

  it('skips extensions that have a server entry (handled by loadExtensions + bridge)', () => {
    const discovered = makeDiscovered('full-ext', 'browser/index', true as const);
    const result = synthesizeBrowserOnlyPackages([discovered]);
    expect(result.packages).toStrictEqual([]);
  });

  it('skips extensions that have only a server entry and no browser entry', () => {
    const discovered = makeDiscovered('server-only', undefined, true as const);
    const result = synthesizeBrowserOnlyPackages([discovered]);
    expect(result.packages).toStrictEqual([]);
  });

  it('synthesizes a MakaioExtension for browser-only extension with correct name and displayName', () => {
    const discovered = makeDiscovered('my-browser-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.name).toBe('my-browser-ext');
    expect(result.packages[0]?.displayName).toBe('my-browser-ext Display');
  });

  it('skips browser-only extensions when framework range excludes current framework version', () => {
    const discovered = makeDiscovered('future-browser-ext', 'browser/index');
    const futureOnly: DiscoveredExtension = {
      ...discovered,
      descriptor: { ...discovered.descriptor, makaio: { framework: '>=4.0.0' } },
    };

    const result = synthesizeBrowserOnlyPackages([futureOnly], {
      frameworkVersion: '3.0.0',
      createMount: () => () => {},
    });

    expect(result.packages).toStrictEqual([]);
    expect(result.configDefaults.size).toBe(0);
  });

  it('sets browser.entrypoint to /extensions/<name>/browser/<filename>', () => {
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    expect(result.packages[0]?.browser).toStrictEqual({
      entrypoint: '/extensions/my-ext/browser/index.js',
    });
  });

  it('resolves surface-name stem to the dist bundle directory', () => {
    // true means "use surface name as stem" and resolves to dist/browser.mjs.
    const discovered = makeDiscovered('makaio-dev', true as const);
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    expect(result.packages[0]?.browser).toStrictEqual({
      entrypoint: '/extensions/makaio-dev/browser/browser.js',
    });
    expect(mountCalls[0]?.serveRoot).toBe(path.join(discovered.extensionPath, 'dist'));
  });

  it('sets http.prefix to /extensions/<name>/browser', () => {
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    expect(result.packages[0]?.http?.prefix).toBe('/extensions/my-ext/browser');
  });

  it('calls createMount with the directory of the browser bundle and correct urlPrefix', () => {
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]?.serveRoot).toBe(path.join(discovered.extensionPath, 'dist/browser'));
    expect(mountCalls[0]?.urlPrefix).toBe('/extensions/my-ext/browser');
  });

  it('mount callback is invoked with the app passed to it', () => {
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    const fakeApp = { use: () => {} };
    result.packages[0]?.http?.mount(fakeApp);

    expect(mountCalls[0]?.mountCalls).toContain(fakeApp);
  });

  it('includes surface from descriptor when declared', () => {
    const discovered = makeDiscovered('surface-ext', 'browser/index');
    // Mutate the descriptor with a surface declaration.
    const withSurface: DiscoveredExtension = {
      ...discovered,
      descriptor: { ...discovered.descriptor, surface: 'interactive' },
    };

    const result = synthesizeBrowserOnlyPackages([withSurface], { createMount: () => () => {} });

    expect(result.packages[0]?.surface).toBe('interactive');
  });

  it('omits surface field when descriptor does not declare it', () => {
    const discovered = makeDiscovered('no-surface', 'browser/index');
    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: () => () => {} });

    expect(result.packages[0]).not.toHaveProperty('surface');
  });

  it('resolves browser entrypoint filename from nested browser path', () => {
    const discovered = makeDiscovered('nested', 'deep/nested/bundle');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: makeMountSpy(mountCalls) });

    expect(result.packages[0]?.browser?.entrypoint).toBe('/extensions/nested/browser/bundle.js');
    expect(mountCalls[0]?.serveRoot).toBe(path.join(discovered.extensionPath, 'dist/deep/nested'));
  });

  it('handles multiple descriptors with mixed cases — only browser-only are synthesized', () => {
    const browserOnly = makeDiscovered('browser-only', 'browser/index');
    const fullExt = makeDiscovered('full-ext', 'browser/index', true as const);
    const serverOnly = makeDiscovered('server-only', undefined, true as const);
    const neither = makeDiscovered('neither');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = synthesizeBrowserOnlyPackages([browserOnly, fullExt, serverOnly, neither], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.name).toBe('browser-only');
    expect(mountCalls).toHaveLength(1);
  });

  it('collects configDefaults from descriptor.config.defaults', () => {
    const defaults = { theme: 'dark', showBadge: true };
    const discovered = makeDiscovered('browser-with-defaults', 'browser/index', undefined, undefined, defaults);

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: () => () => {} });

    expect(result.configDefaults.size).toBe(1);
    expect(result.configDefaults.get('browser-with-defaults')).toStrictEqual(defaults);
  });

  it('omits configDefaults entry when descriptor has no config.defaults', () => {
    const discovered = makeDiscovered('no-defaults', 'browser/index');

    const result = synthesizeBrowserOnlyPackages([discovered], { createMount: () => () => {} });

    expect(result.configDefaults.size).toBe(0);
  });

  it('collects configDefaults only for synthesized browser-only extensions, not skipped ones', () => {
    const browserOnly = makeDiscovered('browser-only', 'browser/index', undefined, undefined, { x: 1 });
    const fullExt = makeDiscovered('full-ext', 'browser/index', true as const, undefined, { y: 2 });

    const result = synthesizeBrowserOnlyPackages([browserOnly, fullExt], { createMount: () => () => {} });

    expect(result.configDefaults.size).toBe(1);
    expect(result.configDefaults.get('browser-only')).toStrictEqual({ x: 1 });
    expect(result.configDefaults.has('full-ext')).toBe(false);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionEntrypoints } from '@makaio/contracts';
import type { KernelMakaioExtension } from '@makaio/kernel';
import type { DiscoveredExtension } from '../extension-discovery.js';
import { bridgeExtensionBrowserEntries } from '../bridge-extension-browser-entries.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid {@link KernelMakaioExtension} fixture.
 * @param name - Package name used as both `name` and `displayName` base.
 * @param overrides - Optional fields merged into the package.
 */
// Test fixtures are intentionally co-located rather than shared with
// synthesize-browser-only-packages.test.ts — each suite's helpers are
// semantically distinct and inline keeps intent transparent.
const makePackage = (name: string, overrides: Partial<KernelMakaioExtension> = {}): KernelMakaioExtension => ({
  name,
  displayName: `${name} Display`,
  version: '0.1.0',
  ...overrides,
});

/**
 * Minimal valid {@link DiscoveredExtension} fixture.
 * @param name - Extension name.
 * @param browserEntry - Optional convention-based browser entrypoint stem (`true` or a custom stem string).
 * @param extensionPath - Absolute path to the extension root.
 */
const makeDiscovered = (name: string, browserEntry?: true | string, extensionPath?: string): DiscoveredExtension => {
  const descriptor: DiscoveredExtension['descriptor'] = {
    name,
    displayName: `${name} Display`,
    version: '1.0.0',
    makaio: { framework: '>=2.0.0' },
    entrypoints: {
      server: true as const,
      ...(browserEntry !== undefined ? { browser: browserEntry } : {}),
    },
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
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-bridge-browser-'));
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

describe('bridgeExtensionBrowserEntries', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-bridge-browser-'));
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (fixtureRoot !== undefined) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('returns empty array when packages is empty', () => {
    const result = bridgeExtensionBrowserEntries([], []);
    expect(result).toStrictEqual([]);
  });

  it('passes through packages with no matching descriptor', () => {
    const pkg = makePackage('orphan-pkg');
    const result = bridgeExtensionBrowserEntries([], [pkg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(pkg);
  });

  it('passes through package when descriptor has no browser entrypoint', () => {
    const pkg = makePackage('no-browser');
    const discovered = makeDiscovered('no-browser');
    const result = bridgeExtensionBrowserEntries([discovered], [pkg]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(pkg);
    expect(result[0]).not.toHaveProperty('browser');
  });

  it('augments package with browser.entrypoint URL following convention', () => {
    const pkg = makePackage('my-ext');
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.browser).toStrictEqual({
      entrypoint: '/extensions/my-ext/browser/index.js',
    });
  });

  it('resolves surface-name stem to the dist bundle directory', () => {
    const pkg = makePackage('makaio-dev');
    // true means "use surface name as stem" and resolves to dist/browser.mjs.
    const discovered = makeDiscovered('makaio-dev', true);
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result[0]?.browser).toStrictEqual({
      entrypoint: '/extensions/makaio-dev/browser/browser.js',
    });
    expect(mountCalls[0]?.serveRoot).toBe(path.join(discovered.extensionPath, 'dist'));
  });

  it('sets http.prefix to /extensions/<name>/browser', () => {
    const pkg = makePackage('my-ext');
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result[0]?.http?.prefix).toBe('/extensions/my-ext/browser');
  });

  it('calls createMount with the directory of the browser bundle', () => {
    const pkg = makePackage('my-ext');
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]?.serveRoot).toBe(path.join(discovered.extensionPath, 'dist/browser'));
    expect(mountCalls[0]?.urlPrefix).toBe('/extensions/my-ext/browser');
  });

  it('mount callback is invoked with the app passed to it', () => {
    const pkg = makePackage('my-ext');
    const discovered = makeDiscovered('my-ext', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    const fakeApp = { use: vi.fn() };
    result[0]?.http?.mount(fakeApp);

    expect(mountCalls[0]?.mountCalls).toContain(fakeApp);
  });

  it('skips with warning when package already declares browser', () => {
    const pkg = makePackage('pre-browser', {
      browser: { entrypoint: '/existing/entry.js' },
    });
    const discovered = makeDiscovered('pre-browser', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result[0]).toBe(pkg);
    expect(result[0]?.browser?.entrypoint).toBe('/existing/entry.js');
    expect(mountCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already declares browser'));
  });

  it('skips with warning when package already declares http', () => {
    const existingMount = vi.fn();
    const pkg = makePackage('pre-http', {
      http: { prefix: '/custom', mount: existingMount },
    });
    const discovered = makeDiscovered('pre-http', 'browser/index');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result[0]).toBe(pkg);
    expect(result[0]?.http?.prefix).toBe('/custom');
    expect(mountCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already declares http'));
  });

  it('does not mutate the input packages array', () => {
    const pkg = makePackage('my-ext');
    const input: KernelMakaioExtension[] = [pkg];
    const discovered = makeDiscovered('my-ext', 'browser/index');

    bridgeExtensionBrowserEntries([discovered], input, {
      createMount: () => () => {},
    });

    expect(input).toHaveLength(1);
    expect(input[0]).toBe(pkg);
    expect(input[0]).not.toHaveProperty('browser');
  });

  it('handles multiple extensions with mixed browser declarations correctly', () => {
    const pkgWithBrowser = makePackage('has-browser');
    const pkgNoBrowser = makePackage('no-browser');
    const pkgPreHttp = makePackage('pre-http', {
      http: { prefix: '/own', mount: () => {} },
    });

    const discoveredWithBrowser = makeDiscovered('has-browser', 'index');
    const discoveredNoBrowser = makeDiscovered('no-browser');
    const discoveredPreHttp = makeDiscovered('pre-http', 'index');

    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries(
      [discoveredWithBrowser, discoveredNoBrowser, discoveredPreHttp],
      [pkgWithBrowser, pkgNoBrowser, pkgPreHttp],
      { createMount: makeMountSpy(mountCalls) },
    );

    // has-browser: augmented
    expect(result[0]?.browser).toStrictEqual({ entrypoint: '/extensions/has-browser/browser/index.js' });
    expect(result[0]?.http?.prefix).toBe('/extensions/has-browser/browser');

    // no-browser: pass-through
    expect(result[1]).toBe(pkgNoBrowser);
    expect(result[1]).not.toHaveProperty('browser');

    // pre-http: skipped with warning
    expect(result[2]).toBe(pkgPreHttp);
    expect(result[2]?.http?.prefix).toBe('/own');

    // only one createMount call (for has-browser)
    expect(mountCalls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('resolves browser entrypoint filename from nested browser path', () => {
    const pkg = makePackage('nested');
    const discovered = makeDiscovered('nested', 'deep/nested/bundle');
    const mountCalls: Array<{ serveRoot: string; urlPrefix: string; mountCalls: unknown[] }> = [];

    const result = bridgeExtensionBrowserEntries([discovered], [pkg], {
      createMount: makeMountSpy(mountCalls),
    });

    expect(result[0]?.browser?.entrypoint).toBe('/extensions/nested/browser/bundle.js');
    expect(mountCalls[0]?.serveRoot).toBe(path.join(discovered.extensionPath, 'dist/deep/nested'));
  });
});

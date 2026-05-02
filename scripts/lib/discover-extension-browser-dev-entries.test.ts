import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeExtensionBrowserEntries } from '@makaio/runtime-node';
import {
  buildBrowserBuildEntryForDescriptorRoot,
  buildBrowserDevEntryForDescriptorRoot,
  buildRuntimeBrowserDevEntryForDescriptorRoot,
  discoverExtensionBrowserBuildEntries,
  discoverExtensionBrowserBuildInputs,
  discoverExtensionBrowserDevEntries,
  discoverExtensionBrowserRuntimeDevEntries,
} from './discover-extension-browser-dev-entries.js';

describe('discoverExtensionBrowserDevEntries', () => {
  const tempDirs: string[] = [];

  /**
   * Create a temporary directory and track it for cleanup.
   * @returns Path to the created temp directory.
   */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'extension-dev-entries-'));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * Write a Makaio config that discovers host extensions.
   * @param cwd - Temporary workspace root.
   */
  function writeConfig(cwd: string): void {
    writeFileSync(
      join(cwd, 'makaio.config.all.ts'),
      [
        "import { defineMakaioConfig } from '@makaio/runtime-node/makaio-config';",
        'export default defineMakaioConfig({',
        "  extensions: { discoveryPaths: ['host/extensions'] },",
        '});',
        '',
      ].join('\n'),
    );
  }

  /**
   * Write an arbitrary Makaio config module for evaluator-surface tests.
   * @param cwd - Temporary workspace root.
   * @param lines - Config source lines.
   */
  function writeConfigModule(cwd: string, lines: readonly string[]): void {
    writeFileSync(join(cwd, 'makaio.config.all.ts'), `${lines.join('\n')}\n`);
  }

  /**
   * Write a descriptor under a host extension directory.
   * @param cwd - Temporary workspace root.
   * @param name - Descriptor name and directory name.
   * @param browser - Optional browser entrypoint.
   * @returns Absolute descriptor root path.
   */
  function writeProductExtensionDescriptor(cwd: string, name: string, browser?: true | string): string {
    const descriptorRoot = join(cwd, 'host/extensions', name);
    mkdirSync(join(descriptorRoot, 'src'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify(
        {
          name,
          displayName: name,
          version: '1.0.0',
          makaio: { minVersion: '0.1.0' },
          entrypoints: browser === undefined ? { server: true } : { browser },
        },
        null,
        2,
      ),
    );
    return descriptorRoot;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('returns an empty array when no configured descriptors exist', () => {
    const cwd = makeTempDir();
    const entries = discoverExtensionBrowserDevEntries(cwd);
    expect(entries).toEqual([]);
  });

  it('does not discover descriptors from default install roots when no config is present', () => {
    const cwd = makeTempDir();
    const installedRoot = join(cwd, '.makaio/node_modules/installed-ext');
    const localRoot = join(cwd, 'node_modules/local-ext');
    mkdirSync(join(installedRoot, 'src'), { recursive: true });
    mkdirSync(join(localRoot, 'src'), { recursive: true });

    for (const [root, name] of [
      [installedRoot, 'installed-ext'],
      [localRoot, 'local-ext'],
    ] as const) {
      writeFileSync(join(root, 'src/browser.ts'), 'export default {};\n');
      writeFileSync(
        join(root, 'descriptor.json'),
        JSON.stringify({
          name,
          displayName: name,
          version: '1.0.0',
          makaio: { minVersion: '0.1.0' },
          entrypoints: { browser: true as const },
        }),
      );
    }

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([]);
    expect(discoverExtensionBrowserBuildEntries(cwd)).toEqual([]);
  });

  it('does not discover descriptors when config explicitly points at node_modules', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, 'makaio.config.json'),
      JSON.stringify({ extensions: { discoveryPaths: ['node_modules'] } }),
    );
    const descriptorRoot = join(cwd, 'node_modules/@scope/ext');
    mkdirSync(join(descriptorRoot, 'src'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'scoped-ext',
        displayName: 'Scoped Ext',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([]);
    expect(discoverExtensionBrowserBuildEntries(cwd)).toEqual([]);
  });

  it('discovers browser dev entries from config discovery paths', () => {
    const cwd = makeTempDir();
    writeConfig(cwd);
    writeProductExtensionDescriptor(cwd, 'makaio-dev', true);

    const entries = discoverExtensionBrowserDevEntries(cwd);

    expect(entries).toEqual([
      {
        urlPath: '/extensions/makaio-dev/browser/browser.ts',
        sourceAbsPath: expect.stringContaining('host/extensions/makaio-dev/src/browser.ts'),
      },
    ]);
  });

  it('preserves non-helper exports from the runtime-node config subpath while evaluating config', () => {
    const cwd = makeTempDir();
    writeConfigModule(cwd, [
      "import { defineMakaioConfig, MAKAIO_HOME_ENV } from '@makaio/runtime-node/makaio-config';",
      'export default defineMakaioConfig({',
      '  launcherCommand: MAKAIO_HOME_ENV.toLowerCase(),',
      "  extensions: { discoveryPaths: ['host/extensions'] },",
      '});',
    ]);
    writeProductExtensionDescriptor(cwd, 'makaio-dev', true);

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/makaio-dev/browser/browser.ts',
        sourceAbsPath: join(cwd, 'host/extensions/makaio-dev/src/browser.ts'),
      },
    ]);
  });

  it('preserves non-helper exports from the runtime-node root module while evaluating config', () => {
    const cwd = makeTempDir();
    writeConfigModule(cwd, [
      "import { defineMakaioConfig, buildExtensionBrowserRuntimeEntrypoint } from '@makaio/runtime-node';",
      'export default defineMakaioConfig({',
      "  launcherCommand: buildExtensionBrowserRuntimeEntrypoint('config-ext', 'browser'),",
      "  extensions: { discoveryPaths: ['host/extensions'] },",
      '});',
    ]);
    writeProductExtensionDescriptor(cwd, 'makaio-dev', true);

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/makaio-dev/browser/browser.ts',
        sourceAbsPath: join(cwd, 'host/extensions/makaio-dev/src/browser.ts'),
      },
    ]);
  });

  it('discovers runtime dev entries that serve the runtime bridge URL', () => {
    const cwd = makeTempDir();
    writeConfig(cwd);
    const descriptorRoot = writeProductExtensionDescriptor(cwd, 'makaio-dev', true);

    const bridged = bridgeExtensionBrowserEntries(
      [
        {
          descriptor: {
            name: 'makaio-dev',
            displayName: 'Makaio Dev',
            version: '1.0.0',
            makaio: { minVersion: '0.1.0' },
            entrypoints: { browser: true as const },
          },
          extensionPath: descriptorRoot,
          source: 'local',
        },
      ],
      [{ name: 'makaio-dev', displayName: 'Makaio Dev' }],
      { createMount: () => () => undefined },
    );

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/makaio-dev/browser/browser.ts',
        sourceAbsPath: join(descriptorRoot, 'src/browser.ts'),
      },
    ]);
    expect(discoverExtensionBrowserRuntimeDevEntries(cwd)).toContainEqual({
      urlPath: bridged[0]?.browser?.entrypoint,
      sourceAbsPath: join(descriptorRoot, 'src/browser.ts'),
    });
  });

  it('selects the first descriptor by name before producing entries', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, 'makaio.config.json'),
      JSON.stringify({ extensions: { discoveryPaths: ['host/extensions/first', 'host/extensions/second'] } }),
    );
    const firstRoot = join(cwd, 'host/extensions/first');
    const secondRoot = join(cwd, 'host/extensions/second');
    for (const [root, browserFile] of [
      [firstRoot, 'first.ts'],
      [secondRoot, 'second.ts'],
    ] as const) {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', browserFile), 'export default {};\n');
      writeFileSync(
        join(root, 'descriptor.json'),
        JSON.stringify({
          name: 'duplicate-ext',
          displayName: 'Duplicate Ext',
          version: '1.0.0',
          makaio: { minVersion: '0.1.0' },
          entrypoints: { browser: browserFile.replace('.ts', '') },
        }),
      );
    }

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/duplicate-ext/browser/first.ts',
        sourceAbsPath: join(firstRoot, 'src/first.ts'),
      },
    ]);
    expect(discoverExtensionBrowserBuildInputs(cwd)).toEqual({
      'extensions/duplicate-ext/browser/first': join(firstRoot, 'src/first.ts'),
    });
  });

  it('applies exclude filters before producing entries', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, 'makaio.config.json'),
      JSON.stringify({ extensions: { discoveryPaths: ['host/extensions'], exclude: ['makaio-*'] } }),
    );
    writeProductExtensionDescriptor(cwd, 'makaio-dev', true);
    writeProductExtensionDescriptor(cwd, 'kept-ext', true);

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/kept-ext/browser/browser.ts',
        sourceAbsPath: join(cwd, 'host/extensions/kept-ext/src/browser.ts'),
      },
    ]);
    expect(discoverExtensionBrowserBuildInputs(cwd)).toEqual({
      'extensions/kept-ext/browser/browser': join(cwd, 'host/extensions/kept-ext/src/browser.ts'),
    });
  });

  it('applies include filters when auto discovery is disabled', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, 'makaio.config.json'),
      JSON.stringify({
        extensions: { autoDiscover: false, discoveryPaths: ['host/extensions'], include: ['included-ext'] },
      }),
    );
    writeProductExtensionDescriptor(cwd, 'included-ext', true);
    writeProductExtensionDescriptor(cwd, 'skipped-ext', true);

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/included-ext/browser/browser.ts',
        sourceAbsPath: join(cwd, 'host/extensions/included-ext/src/browser.ts'),
      },
    ]);
  });

  it('allows explicit descriptor roots under node_modules when config points directly at them', () => {
    const cwd = makeTempDir();
    const extRoot = join(cwd, 'node_modules/@scope/linked-ext');
    mkdirSync(join(extRoot, 'src'), { recursive: true });
    writeFileSync(join(extRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(extRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'linked-ext',
        displayName: 'Linked Extension',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );
    writeFileSync(
      join(cwd, 'makaio.config.json'),
      JSON.stringify({ extensions: { discoveryPaths: ['node_modules/@scope/linked-ext'] } }),
    );

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/linked-ext/browser/browser.ts',
        sourceAbsPath: join(extRoot, 'src/browser.ts'),
      },
    ]);
  });

  it('skips node_modules while recursively searching configured discovery paths', () => {
    const cwd = makeTempDir();
    writeConfig(cwd);
    writeProductExtensionDescriptor(cwd, 'makaio-dev', true);
    const nestedRoot = join(cwd, 'host/extensions/node_modules/nested-ext');
    mkdirSync(join(nestedRoot, 'src'), { recursive: true });
    writeFileSync(join(nestedRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(nestedRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'nested-ext',
        displayName: 'nested-ext',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );

    expect(discoverExtensionBrowserDevEntries(cwd)).toEqual([
      {
        urlPath: '/extensions/makaio-dev/browser/browser.ts',
        sourceAbsPath: join(cwd, 'host/extensions/makaio-dev/src/browser.ts'),
      },
    ]);
  });

  it('returns an empty array when configured descriptors have no entrypoints.browser', () => {
    const cwd = makeTempDir();
    writeConfig(cwd);
    writeProductExtensionDescriptor(cwd, 'server-only');

    const entries = discoverExtensionBrowserDevEntries(cwd);

    expect(entries).toEqual([]);
  });

  it('skips descriptors whose browser entry escapes the extension directory', () => {
    const cwd = makeTempDir();
    writeConfig(cwd);
    const descriptorRoot = writeProductExtensionDescriptor(cwd, 'traversal-ext', true);
    const outsideBrowserEntry = join(cwd, 'outside.ts');
    writeFileSync(outsideBrowserEntry, 'export default {};\n');
    rmSync(join(descriptorRoot, 'src/browser.ts'), { force: true });
    // Parent-traversing descriptor paths are rejected by the schema before this
    // point; the runtime containment warning is reached by valid paths whose
    // filesystem target escapes through realpath resolution.
    symlinkSync(outsideBrowserEntry, join(descriptorRoot, 'src/browser.ts'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const entries = discoverExtensionBrowserDevEntries(cwd);

    expect(entries).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
      'browser entry has no resolvable candidate within extension directory',
    );
  });
});

describe('descriptor browser build entries', () => {
  const tempDirs: string[] = [];

  /**
   * Create a temporary directory and track it for cleanup.
   * @returns Path to the created temp directory.
   */
  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'extension-browser-build-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a dev entry directly from a descriptor root', () => {
    const cwd = makeTempDir();
    const descriptorRoot = join(cwd, 'host/extensions/makaio-dev');
    mkdirSync(join(descriptorRoot, 'src'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );

    expect(buildBrowserDevEntryForDescriptorRoot(descriptorRoot)).toEqual({
      urlPath: '/extensions/makaio-dev/browser/browser.ts',
      sourceAbsPath: join(descriptorRoot, 'src/browser.ts'),
    });
  });

  it('builds a runtime dev entry directly from a descriptor root', () => {
    const cwd = makeTempDir();
    const descriptorRoot = join(cwd, 'host/extensions/makaio-dev');
    mkdirSync(join(descriptorRoot, 'src'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );

    expect(buildRuntimeBrowserDevEntryForDescriptorRoot(descriptorRoot)).toEqual({
      urlPath: '/extensions/makaio-dev/browser/browser.js',
      sourceAbsPath: join(descriptorRoot, 'src/browser.ts'),
    });
  });

  it('resolves a custom stem to a nested source file', () => {
    const cwd = makeTempDir();
    const descriptorRoot = join(cwd, 'host/extensions/makaio-dev');
    mkdirSync(join(descriptorRoot, 'src/browser'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser/index.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: 'browser/index' },
      }),
    );

    expect(buildBrowserDevEntryForDescriptorRoot(descriptorRoot)).toEqual({
      urlPath: '/extensions/makaio-dev/browser/index.ts',
      sourceAbsPath: join(descriptorRoot, 'src/browser/index.ts'),
    });
    expect(buildRuntimeBrowserDevEntryForDescriptorRoot(descriptorRoot)).toEqual({
      urlPath: '/extensions/makaio-dev/browser/index.js',
      sourceAbsPath: join(descriptorRoot, 'src/browser/index.ts'),
    });
    expect(buildBrowserBuildEntryForDescriptorRoot(descriptorRoot)).toEqual({
      inputName: 'extensions/makaio-dev/browser/index',
      sourceAbsPath: join(descriptorRoot, 'src/browser/index.ts'),
    });
  });

  it('builds a production input entry with a normalized extension-free input name', () => {
    const cwd = makeTempDir();
    const descriptorRoot = join(cwd, 'host/extensions/makaio-dev');
    mkdirSync(join(descriptorRoot, 'src'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );

    expect(buildBrowserBuildEntryForDescriptorRoot(descriptorRoot)).toEqual({
      inputName: 'extensions/makaio-dev/browser/browser',
      sourceAbsPath: join(descriptorRoot, 'src/browser.ts'),
    });
  });

  it('discovers production build inputs from the same config descriptor roots', () => {
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, 'makaio.config.json'),
      JSON.stringify({ extensions: { discoveryPaths: ['host/extensions'] } }),
    );
    const descriptorRoot = join(cwd, 'host/extensions/makaio-dev');
    mkdirSync(join(descriptorRoot, 'src'), { recursive: true });
    writeFileSync(join(descriptorRoot, 'src/browser.ts'), 'export default {};\n');
    writeFileSync(
      join(descriptorRoot, 'descriptor.json'),
      JSON.stringify({
        name: 'makaio-dev',
        displayName: 'Makaio Dev',
        version: '1.0.0',
        makaio: { minVersion: '0.1.0' },
        entrypoints: { browser: true as const },
      }),
    );

    expect(discoverExtensionBrowserBuildEntries(cwd)).toEqual([
      {
        inputName: 'extensions/makaio-dev/browser/browser',
        sourceAbsPath: join(descriptorRoot, 'src/browser.ts'),
      },
    ]);
    expect(discoverExtensionBrowserBuildInputs(cwd)).toEqual({
      'extensions/makaio-dev/browser/browser': join(descriptorRoot, 'src/browser.ts'),
    });
  });
});

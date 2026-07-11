import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExplicitDescriptorDiscovery,
  FilesystemDescriptorDiscovery,
  MergedDescriptorDiscovery,
  type DiscoveredExtension,
} from '../extension-discovery.js';

const baseDescriptor = {
  name: 'test-extension',
  displayName: 'Test Extension',
  version: '1.0.0',
  makaio: { framework: '>=2.0.0' },
  entrypoints: { server: true as const },
};

/**
 * Write a descriptor.json file into the given directory.
 * @param dir - Absolute path to the directory.
 * @param content - String content to write.
 */
async function writeDescriptor(dir: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'descriptor.json'), content, 'utf-8');
}

describe('FilesystemDescriptorDiscovery', () => {
  let tmpDir: string;
  let nodeModules: string;
  let extensionsDir: string;
  let globalNodeModules: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-discovery-test-'));
    nodeModules = path.join(tmpDir, 'node_modules');
    extensionsDir = path.join(tmpDir, 'extensions');
    globalNodeModules = path.join(tmpDir, 'global-node_modules');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no descriptors found', async () => {
    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();
    expect(result).toStrictEqual([]);
  });

  it('does not glob the cwd when installed/global directories are omitted', async () => {
    const originalCwd = process.cwd();
    await writeDescriptor(path.join(tmpDir, 'unexpected-cwd-match'), JSON.stringify(baseDescriptor));

    try {
      process.chdir(tmpDir);
      const discovery = new FilesystemDescriptorDiscovery(tmpDir);
      const result = await discovery.discover();
      expect(result).toStrictEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('discovers descriptor.json in node_modules flat package', async () => {
    await writeDescriptor(path.join(nodeModules, 'my-extension'), JSON.stringify(baseDescriptor));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.name).toBe('test-extension');
    expect(result[0]?.source).toBe('local');
    expect(result[0]?.extensionPath).toBe(path.join(nodeModules, 'my-extension'));
  });

  it('discovers the shipped SDK-native Cursor adapter descriptor', async () => {
    const descriptorPath = path.resolve(
      import.meta.dirname,
      '../../../../adapters/implementations/cursor-sdk/descriptor.json',
    );
    await writeDescriptor(path.join(nodeModules, 'cursor-sdk'), await fs.readFile(descriptorPath, 'utf8'));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.name).toBe('cursor-sdk');
    expect(result[0]?.descriptor.contributions?.adapters?.[0]?.protocols).toEqual([]);
  });

  it('discovers descriptor.json in node_modules scoped package (@scope/pkg)', async () => {
    await writeDescriptor(path.join(nodeModules, '@scope', 'my-scoped-ext'), JSON.stringify(baseDescriptor));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.name).toBe('test-extension');
    expect(result[0]?.source).toBe('local');
    expect(result[0]?.extensionPath).toBe(path.join(nodeModules, '@scope', 'my-scoped-ext'));
  });

  it('can skip the project-local node_modules tier', async () => {
    await writeDescriptor(
      path.join(nodeModules, 'local-ext'),
      JSON.stringify({ ...baseDescriptor, name: 'local-ext', displayName: 'Local Ext' }),
    );
    await writeDescriptor(
      path.join(extensionsDir, 'installed-ext'),
      JSON.stringify({ ...baseDescriptor, name: 'installed-ext', displayName: 'Installed Ext' }),
    );

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, {
      localNodeModulesDir: false,
      extensionsDir,
      nodeModulesDir: globalNodeModules,
    });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.name).toBe('installed-ext');
    expect(result[0]?.source).toBe('installed');
  });

  it('discovers descriptor.json in the installed extensions directory', async () => {
    await writeDescriptor(path.join(extensionsDir, 'my-installed-ext'), JSON.stringify(baseDescriptor));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.name).toBe('test-extension');
    expect(result[0]?.source).toBe('installed');
  });

  it('skips descriptors with invalid JSON', async () => {
    await writeDescriptor(path.join(nodeModules, 'bad-json-ext'), 'NOT_VALID_JSON{{{');

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(0);
  });

  it('skips descriptors that fail Zod validation (missing required fields)', async () => {
    await writeDescriptor(
      path.join(nodeModules, 'invalid-schema-ext'),
      JSON.stringify({ name: 'missing-required-fields' }),
    );

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(0);
  });

  it('deduplicates by name — local wins over installed', async () => {
    const localDescriptor = {
      ...baseDescriptor,
      name: 'same-name-ext',
      displayName: 'Local Version',
    };
    const installedDescriptor = {
      ...baseDescriptor,
      name: 'same-name-ext',
      displayName: 'Installed Version',
    };

    await writeDescriptor(path.join(nodeModules, 'same-name-ext'), JSON.stringify(localDescriptor));
    await writeDescriptor(path.join(extensionsDir, 'same-name-ext'), JSON.stringify(installedDescriptor));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.displayName).toBe('Local Version');
    expect(result[0]?.source).toBe('local');
  });

  it('returns both when local and installed have different names', async () => {
    const localDescriptor = { ...baseDescriptor, name: 'local-ext', displayName: 'Local Ext' };
    const installedDescriptor = { ...baseDescriptor, name: 'installed-ext', displayName: 'Installed Ext' };

    await writeDescriptor(path.join(nodeModules, 'local-ext'), JSON.stringify(localDescriptor));
    await writeDescriptor(path.join(extensionsDir, 'installed-ext'), JSON.stringify(installedDescriptor));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(2);
    const names = result.map((r) => r.descriptor.name).sort();
    expect(names).toStrictEqual(['installed-ext', 'local-ext']);
  });

  it('discovers descriptor.json in the global npm directory', async () => {
    await writeDescriptor(path.join(globalNodeModules, '@scope', 'global-ext'), JSON.stringify(baseDescriptor));

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.name).toBe('test-extension');
    expect(result[0]?.source).toBe('global-npm');
    expect(result[0]?.extensionPath).toBe(path.join(globalNodeModules, '@scope', 'global-ext'));
  });

  it('deduplicates across all tiers in priority order: local, installed, then global-npm', async () => {
    const sharedDescriptor = {
      ...baseDescriptor,
      name: 'same-name-ext',
    };

    await writeDescriptor(
      path.join(globalNodeModules, 'same-name-ext'),
      JSON.stringify({ ...sharedDescriptor, displayName: 'Global Version' }),
    );
    await writeDescriptor(
      path.join(extensionsDir, 'same-name-ext'),
      JSON.stringify({ ...sharedDescriptor, displayName: 'Installed Version' }),
    );
    await writeDescriptor(
      path.join(nodeModules, 'same-name-ext'),
      JSON.stringify({ ...sharedDescriptor, displayName: 'Local Version' }),
    );

    const discovery = new FilesystemDescriptorDiscovery(tmpDir, { extensionsDir, nodeModulesDir: globalNodeModules });
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]?.descriptor.displayName).toBe('Local Version');
    expect(result[0]?.source).toBe('local');
  });
});

describe('ExplicitDescriptorDiscovery', () => {
  it('returns the provided list unchanged', async () => {
    const extensions: DiscoveredExtension[] = [
      {
        descriptor: {
          ...baseDescriptor,
          name: 'explicit-ext',
          displayName: 'Explicit Ext',
        },
        extensionPath: '/some/path',
        source: 'local',
      },
    ];

    const discovery = new ExplicitDescriptorDiscovery(extensions);
    const result = await discovery.discover();

    expect(result).toBe(extensions);
  });

  it('returns an empty array when constructed with an empty list', async () => {
    const discovery = new ExplicitDescriptorDiscovery([]);
    const result = await discovery.discover();

    expect(result).toStrictEqual([]);
  });
});

describe('MergedDescriptorDiscovery', () => {
  it('keeps the first discovery result on name collision', async () => {
    const local: DiscoveredExtension = {
      descriptor: { ...baseDescriptor, name: 'shared-ext', displayName: 'Local' },
      extensionPath: '/local/shared-ext',
      source: 'local',
    };
    const installed: DiscoveredExtension = {
      descriptor: { ...baseDescriptor, name: 'shared-ext', displayName: 'Installed' },
      extensionPath: '/installed/shared-ext',
      source: 'installed',
    };

    const discovery = new MergedDescriptorDiscovery([
      new ExplicitDescriptorDiscovery([local]),
      new ExplicitDescriptorDiscovery([installed]),
    ]);
    const result = await discovery.discover();

    expect(result).toHaveLength(1);
    expect(result[0]).toStrictEqual(local);
  });

  it('appends non-conflicting names from later discoveries', async () => {
    const first: DiscoveredExtension = {
      descriptor: { ...baseDescriptor, name: 'first-ext', displayName: 'First' },
      extensionPath: '/first',
      source: 'local',
    };
    const second: DiscoveredExtension = {
      descriptor: { ...baseDescriptor, name: 'second-ext', displayName: 'Second' },
      extensionPath: '/second',
      source: 'global-npm',
    };

    const discovery = new MergedDescriptorDiscovery([
      new ExplicitDescriptorDiscovery([first]),
      new ExplicitDescriptorDiscovery([second]),
    ]);
    const result = await discovery.discover();

    expect(result).toStrictEqual([first, second]);
  });
});

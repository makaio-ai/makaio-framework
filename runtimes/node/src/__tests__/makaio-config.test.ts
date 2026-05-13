import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAKAIO_CONFIG_FILE_ENV,
  MAKAIO_HOME_ENV,
  createMakaioConfigDiscovery,
  defineMakaioConfig,
  loadMakaioConfig,
  parseMakaioConfig,
  resolveMakaioHome,
  resolveMakaioConfigPath,
} from '../makaio-config.js';

const baseDescriptor = {
  name: 'test-extension',
  displayName: 'Test Extension',
  version: '1.0.0',
  makaio: { framework: '>=0.1.0' },
  entrypoints: { server: true as const },
};

interface TestDescriptor {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly makaio: { readonly framework: string };
  readonly entrypoints: { readonly server: true | string };
}

/**
 * Write a descriptor file under a package directory.
 * @param dir - Package directory.
 * @param descriptor - Descriptor JSON payload.
 */
async function writeDescriptor(dir: string, descriptor: TestDescriptor): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'descriptor.json'), JSON.stringify(descriptor), 'utf-8');
}

describe('makaio config', () => {
  let tmpDir: string;
  let makaioHome: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-config-test-'));
    makaioHome = path.join(tmpDir, '.makaio');
    await fs.mkdir(makaioHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps defineMakaioConfig as a typed identity helper', () => {
    const config = { extensions: { include: ['account-manager'] } };

    expect(defineMakaioConfig(config)).toBe(config);
  });

  it('parses defaults and resolves relative discovery paths from the config directory', () => {
    const parsed = parseMakaioConfig(
      {
        extensions: {
          autoDiscover: false,
          discoveryPaths: ['extensions', path.join(tmpDir, 'absolute-root')],
          include: ['account-*'],
          exclude: ['*-legacy'],
        },
        launcherCommand: 'makaio-dev',
        packageConfigDefaults: {
          'account-manager': { makaioCommand: 'makaio-dev' },
        },
      },
      { baseDir: tmpDir, makaioHome },
    );

    expect(parsed.extensions).toEqual({
      autoDiscover: false,
      discoveryPaths: [path.join(tmpDir, 'extensions'), path.join(tmpDir, 'absolute-root')],
      discoveryRoots: [
        { path: path.join(tmpDir, 'extensions'), source: 'local' },
        { path: path.join(tmpDir, 'absolute-root'), source: 'local' },
      ],
      include: ['account-*'],
      exclude: ['*-legacy'],
    });
    expect(parsed.launcherCommand).toBe('makaio-dev');
    expect(parsed.packageConfigDefaults.get('account-manager')).toEqual({ makaioCommand: 'makaio-dev' });
  });

  it('defaults installed extension roots when no discovery paths are declared', () => {
    const parsed = parseMakaioConfig({}, { baseDir: tmpDir, makaioHome });

    expect(parsed.extensions.discoveryPaths).toEqual([
      path.join(makaioHome, 'extensions'),
      path.join(makaioHome, 'node_modules'),
    ]);
    expect(parsed.extensions.discoveryRoots).toEqual([
      { path: path.join(makaioHome, 'extensions'), source: 'installed' },
      { path: path.join(makaioHome, 'node_modules'), source: 'global-npm' },
    ]);
    expect(parsed.extensions.autoDiscover).toBe(true);
    expect(parsed.launcherCommand).toBe('makaio');
  });

  it('resolves Makaio home from env before the user default', () => {
    const customHome = path.join(tmpDir, 'dev-home');

    expect(resolveMakaioHome({ [MAKAIO_HOME_ENV]: customHome })).toBe(customHome);
    expect(resolveMakaioHome({ [MAKAIO_HOME_ENV]: '   ' })).toBe(path.join(os.homedir(), '.makaio'));
  });

  it('resolves explicit config path before env and default lookup', async () => {
    const explicit = path.join(tmpDir, 'explicit.json');
    const envConfig = path.join(tmpDir, 'env.json');
    const defaultConfig = path.join(makaioHome, 'makaio.config.json');
    await fs.writeFile(explicit, '{}', 'utf-8');
    await fs.writeFile(envConfig, '{}', 'utf-8');
    await fs.writeFile(defaultConfig, '{}', 'utf-8');

    await expect(
      resolveMakaioConfigPath({
        makaioHome,
        configPath: explicit,
        env: { [MAKAIO_CONFIG_FILE_ENV]: envConfig },
      }),
    ).resolves.toBe(explicit);
  });

  it('loads json config through the same parser', async () => {
    const configPath = path.join(makaioHome, 'makaio.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        extensions: { discoveryPaths: ['extensions'] },
        packageConfigDefaults: { 'account-manager': { makaioCommand: 'json-makaio' } },
      }),
      'utf-8',
    );

    const loaded = await loadMakaioConfig({ makaioHome });

    expect(loaded.configPath).toBe(configPath);
    expect(loaded.config.extensions.discoveryPaths).toEqual([path.join(makaioHome, 'extensions')]);
    expect(loaded.config.packageConfigDefaults.get('account-manager')).toEqual({ makaioCommand: 'json-makaio' });
  });

  it('reports invalid json config with source context', async () => {
    const configPath = path.join(makaioHome, 'makaio.config.json');
    await fs.writeFile(configPath, '{ invalid json', 'utf-8');

    await expect(loadMakaioConfig({ makaioHome })).rejects.toThrow(`at ${configPath}`);
  });

  it('reports schema-invalid config with source context', async () => {
    const configPath = path.join(makaioHome, 'makaio.config.json');
    await fs.writeFile(configPath, JSON.stringify({ hostCapabilities: ['host'] }), 'utf-8');

    await expect(loadMakaioConfig({ makaioHome })).rejects.toThrow(`at ${configPath}`);
  });

  it('discovers descriptor roots with include and exclude filters', async () => {
    const root = path.join(tmpDir, 'extensions');
    await writeDescriptor(path.join(root, 'account-manager'), {
      ...baseDescriptor,
      name: 'account-manager',
      displayName: 'Account Manager',
    });
    await writeDescriptor(path.join(root, 'account-legacy'), {
      ...baseDescriptor,
      name: 'account-legacy',
      displayName: 'Account Legacy',
    });
    await writeDescriptor(path.join(root, 'terminal'), {
      ...baseDescriptor,
      name: 'terminal',
      displayName: 'Terminal',
    });

    const discovery = createMakaioConfigDiscovery(
      parseMakaioConfig(
        {
          extensions: {
            discoveryPaths: [root],
            include: ['account-*'],
            exclude: ['*-legacy'],
          },
        },
        { baseDir: tmpDir, makaioHome },
      ),
    );

    const discovered = await discovery.discover();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      descriptor: { name: 'account-manager' },
      extensionPath: path.join(root, 'account-manager'),
      source: 'local',
    });
  });

  it('uses include as the explicit allow-list when autoDiscover is false', async () => {
    const root = path.join(tmpDir, 'extensions');
    await writeDescriptor(path.join(root, 'account-manager'), {
      ...baseDescriptor,
      name: 'account-manager',
      displayName: 'Account Manager',
    });
    await writeDescriptor(path.join(root, 'terminal'), {
      ...baseDescriptor,
      name: 'terminal',
      displayName: 'Terminal',
    });

    const discovery = createMakaioConfigDiscovery(
      parseMakaioConfig(
        {
          extensions: {
            autoDiscover: false,
            discoveryPaths: [root],
            include: ['terminal'],
          },
        },
        { baseDir: tmpDir, makaioHome },
      ),
    );

    const result = await discovery.discover();

    expect(result.map((extension) => extension.descriptor.name)).toEqual(['terminal']);
  });

  describe('parseMakaioConfig', () => {
    it('treats null input as empty config with all defaults', () => {
      const parsed = parseMakaioConfig(null, { baseDir: tmpDir, makaioHome });

      expect(parsed.extensions.autoDiscover).toBe(true);
      expect(parsed.extensions.discoveryPaths).toEqual([
        path.join(makaioHome, 'extensions'),
        path.join(makaioHome, 'node_modules'),
      ]);
      expect(parsed.extensions.discoveryRoots).toEqual([
        { path: path.join(makaioHome, 'extensions'), source: 'installed' },
        { path: path.join(makaioHome, 'node_modules'), source: 'global-npm' },
      ]);
      expect(parsed.extensions.include).toEqual([]);
      expect(parsed.extensions.exclude).toEqual([]);
      expect(parsed.launcherCommand).toBe('makaio');
      expect(parsed.packageConfigDefaults).toEqual(new Map());
    });

    it('treats undefined input as empty config with all defaults', () => {
      const parsed = parseMakaioConfig(undefined, { baseDir: tmpDir, makaioHome });

      expect(parsed.extensions.autoDiscover).toBe(true);
      expect(parsed.launcherCommand).toBe('makaio');
      expect(parsed.packageConfigDefaults).toEqual(new Map());
    });

    it('rejects unknown top-level fields via strict schema', () => {
      expect(() => parseMakaioConfig({ unknownField: 'value' }, { baseDir: tmpDir, makaioHome })).toThrow(
        /Invalid Makaio runtime config/,
      );
    });

    it('includes source label in schema error when provided', () => {
      expect(() =>
        parseMakaioConfig(
          { unknownField: 'value' },
          { baseDir: tmpDir, makaioHome, source: '/path/to/makaio.config.ts' },
        ),
      ).toThrow('at /path/to/makaio.config.ts');
    });

    it('converts packageConfigDefaults record to a Map', () => {
      const parsed = parseMakaioConfig(
        {
          packageConfigDefaults: {
            alpha: { key: 'a' },
            beta: { key: 'b' },
          },
        },
        { baseDir: tmpDir, makaioHome },
      );

      expect(parsed.packageConfigDefaults).toBeInstanceOf(Map);
      expect(parsed.packageConfigDefaults.size).toBe(2);
      expect(parsed.packageConfigDefaults.get('alpha')).toEqual({ key: 'a' });
      expect(parsed.packageConfigDefaults.get('beta')).toEqual({ key: 'b' });
    });

    it('resolves all relative discovery paths against baseDir', () => {
      const parsed = parseMakaioConfig(
        { extensions: { discoveryPaths: ['rel-a', 'rel-b'] } },
        { baseDir: tmpDir, makaioHome },
      );

      expect(parsed.extensions.discoveryPaths).toEqual([path.resolve(tmpDir, 'rel-a'), path.resolve(tmpDir, 'rel-b')]);
    });

    it('preserves absolute discovery paths unchanged', () => {
      const absPath = path.join(tmpDir, 'absolute-extensions');
      const parsed = parseMakaioConfig(
        { extensions: { discoveryPaths: [absPath] } },
        { baseDir: '/different/base', makaioHome },
      );

      expect(parsed.extensions.discoveryPaths).toEqual([absPath]);
    });
  });

  describe('resolveMakaioConfigPath', () => {
    it('falls back to MAKAIO_CONFIG_FILE env var when no explicit path', async () => {
      const envConfig = path.join(tmpDir, 'env-config.json');
      await fs.writeFile(envConfig, '{}', 'utf-8');

      const resolved = await resolveMakaioConfigPath({
        makaioHome,
        env: { [MAKAIO_CONFIG_FILE_ENV]: envConfig },
      });

      expect(resolved).toBe(envConfig);
    });

    it('trims whitespace from env var config path', async () => {
      const envConfig = path.join(tmpDir, 'env-config.json');
      await fs.writeFile(envConfig, '{}', 'utf-8');

      const resolved = await resolveMakaioConfigPath({
        makaioHome,
        env: { [MAKAIO_CONFIG_FILE_ENV]: `  ${envConfig}  ` },
      });

      expect(resolved).toBe(envConfig);
    });

    it('ignores blank env var and falls through to default lookup', async () => {
      const resolved = await resolveMakaioConfigPath({
        makaioHome,
        env: { [MAKAIO_CONFIG_FILE_ENV]: '   ' },
      });

      expect(resolved).toBeUndefined();
    });

    it('prefers makaio.config.ts over .js and .json in default lookup', async () => {
      await fs.writeFile(path.join(makaioHome, 'makaio.config.ts'), '', 'utf-8');
      await fs.writeFile(path.join(makaioHome, 'makaio.config.js'), '', 'utf-8');
      await fs.writeFile(path.join(makaioHome, 'makaio.config.json'), '', 'utf-8');

      const resolved = await resolveMakaioConfigPath({ makaioHome });

      expect(resolved).toBe(path.join(makaioHome, 'makaio.config.ts'));
    });

    it('prefers makaio.config.js over .json when .ts is absent', async () => {
      await fs.writeFile(path.join(makaioHome, 'makaio.config.js'), '', 'utf-8');
      await fs.writeFile(path.join(makaioHome, 'makaio.config.json'), '', 'utf-8');

      const resolved = await resolveMakaioConfigPath({ makaioHome });

      expect(resolved).toBe(path.join(makaioHome, 'makaio.config.js'));
    });

    it('falls back to makaio.config.json when .ts and .js are absent', async () => {
      await fs.writeFile(path.join(makaioHome, 'makaio.config.json'), '', 'utf-8');

      const resolved = await resolveMakaioConfigPath({ makaioHome });

      expect(resolved).toBe(path.join(makaioHome, 'makaio.config.json'));
    });

    it('returns undefined when no config file exists', async () => {
      const resolved = await resolveMakaioConfigPath({ makaioHome });

      expect(resolved).toBeUndefined();
    });

    it('throws when explicit configPath does not exist', async () => {
      const missing = path.join(tmpDir, 'nonexistent.json');

      await expect(resolveMakaioConfigPath({ makaioHome, configPath: missing })).rejects.toThrow(
        `Missing runtime config: ${missing}`,
      );
    });

    it('throws when env var config path does not exist', async () => {
      const missing = path.join(tmpDir, 'missing-env.json');

      await expect(
        resolveMakaioConfigPath({
          makaioHome,
          env: { [MAKAIO_CONFIG_FILE_ENV]: missing },
        }),
      ).rejects.toThrow(`Missing runtime config: ${missing}`);
    });
  });

  describe('ConfiguredDescriptorDiscovery', () => {
    it('preserves installed root source provenance from default discovery paths', async () => {
      await writeDescriptor(path.join(makaioHome, 'extensions', 'installed-ext'), {
        ...baseDescriptor,
        name: 'installed-ext',
        displayName: 'Installed Extension',
      });
      await writeDescriptor(path.join(makaioHome, 'node_modules', 'global-ext'), {
        ...baseDescriptor,
        name: 'global-ext',
        displayName: 'Global Extension',
      });

      const discovery = createMakaioConfigDiscovery(parseMakaioConfig({}, { baseDir: tmpDir, makaioHome }));

      const result = await discovery.discover();

      expect(result).toEqual([
        expect.objectContaining({
          descriptor: expect.objectContaining({ name: 'installed-ext' }),
          extensionPath: path.join(makaioHome, 'extensions', 'installed-ext'),
          source: 'installed',
        }),
        expect.objectContaining({
          descriptor: expect.objectContaining({ name: 'global-ext' }),
          extensionPath: path.join(makaioHome, 'node_modules', 'global-ext'),
          source: 'global-npm',
        }),
      ]);
    });

    it('includes all discovered extensions when autoDiscover is true', async () => {
      const root = path.join(tmpDir, 'extensions');
      await writeDescriptor(path.join(root, 'alpha'), {
        ...baseDescriptor,
        name: 'alpha',
        displayName: 'Alpha',
      });
      await writeDescriptor(path.join(root, 'beta'), {
        ...baseDescriptor,
        name: 'beta',
        displayName: 'Beta',
      });

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig(
          { extensions: { autoDiscover: true, discoveryPaths: [root] } },
          { baseDir: tmpDir, makaioHome },
        ),
      );

      const result = await discovery.discover();
      const names = result.map((ext) => ext.descriptor.name).sort();

      expect(names).toEqual(['alpha', 'beta']);
    });

    it('excludes all extensions when autoDiscover is false and include is empty', async () => {
      const root = path.join(tmpDir, 'extensions');
      await writeDescriptor(path.join(root, 'alpha'), {
        ...baseDescriptor,
        name: 'alpha',
        displayName: 'Alpha',
      });

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig(
          { extensions: { autoDiscover: false, discoveryPaths: [root] } },
          { baseDir: tmpDir, makaioHome },
        ),
      );

      const result = await discovery.discover();

      expect(result).toEqual([]);
    });

    it('exclude wins over include for the same extension', async () => {
      const root = path.join(tmpDir, 'extensions');
      await writeDescriptor(path.join(root, 'target'), {
        ...baseDescriptor,
        name: 'target',
        displayName: 'Target',
      });

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig(
          {
            extensions: {
              discoveryPaths: [root],
              include: ['target'],
              exclude: ['target'],
            },
          },
          { baseDir: tmpDir, makaioHome },
        ),
      );

      const result = await discovery.discover();

      expect(result).toEqual([]);
    });

    it('deduplicates by name using first-match-wins across paths', async () => {
      const rootA = path.join(tmpDir, 'extensions-a');
      const rootB = path.join(tmpDir, 'extensions-b');
      await writeDescriptor(path.join(rootA, 'shared'), {
        ...baseDescriptor,
        name: 'shared',
        displayName: 'Shared from A',
      });
      await writeDescriptor(path.join(rootB, 'shared'), {
        ...baseDescriptor,
        name: 'shared',
        displayName: 'Shared from B',
      });

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig({ extensions: { discoveryPaths: [rootA, rootB] } }, { baseDir: tmpDir, makaioHome }),
      );

      const result = await discovery.discover();

      expect(result).toHaveLength(1);
      expect(result[0]!.extensionPath).toBe(path.join(rootA, 'shared'));
    });

    it('discovers from multiple paths and merges results', async () => {
      const rootA = path.join(tmpDir, 'extensions-a');
      const rootB = path.join(tmpDir, 'extensions-b');
      await writeDescriptor(path.join(rootA, 'alpha'), {
        ...baseDescriptor,
        name: 'alpha',
        displayName: 'Alpha',
      });
      await writeDescriptor(path.join(rootB, 'beta'), {
        ...baseDescriptor,
        name: 'beta',
        displayName: 'Beta',
      });

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig({ extensions: { discoveryPaths: [rootA, rootB] } }, { baseDir: tmpDir, makaioHome }),
      );

      const result = await discovery.discover();
      const names = result.map((ext) => ext.descriptor.name).sort();

      expect(names).toEqual(['alpha', 'beta']);
    });

    it('returns empty array when discovery path does not exist', async () => {
      const missing = path.join(tmpDir, 'nonexistent');

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig({ extensions: { discoveryPaths: [missing] } }, { baseDir: tmpDir, makaioHome }),
      );

      const result = await discovery.discover();

      expect(result).toEqual([]);
    });

    it('discovers from a node_modules-shaped path with flat and scoped packages', async () => {
      const nmDir = path.join(tmpDir, 'node_modules');
      await writeDescriptor(path.join(nmDir, 'pkg-a'), {
        ...baseDescriptor,
        name: 'pkg-a',
        displayName: 'Package A',
      });
      await writeDescriptor(path.join(nmDir, '@scope', 'pkg-b'), {
        ...baseDescriptor,
        name: 'scoped-pkg-b',
        displayName: 'Scoped Package B',
      });

      const discovery = createMakaioConfigDiscovery(
        parseMakaioConfig({ extensions: { discoveryPaths: [nmDir] } }, { baseDir: tmpDir, makaioHome }),
      );

      const result = await discovery.discover();
      const names = result.map((ext) => ext.descriptor.name).sort();

      expect(names).toEqual(['pkg-a', 'scoped-pkg-b']);
    });
  });
});

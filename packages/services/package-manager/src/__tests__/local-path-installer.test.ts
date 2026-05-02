import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalPathInstaller } from '../local-path-installer.js';

/**
 * Minimal valid descriptor.json content for test fixtures.
 * @param name - Extension name (plain or npm-scoped, e.g. `'my-ext'` or `'@acme/weather-tools'`).
 * @param version - Extension version string.
 * @returns A descriptor object valid against {@link ExtensionDescriptorSchema}.
 */
function makeDescriptor(name: string, version = '1.0.0'): Record<string, unknown> {
  return {
    name,
    displayName: name,
    version,
    makaio: { minVersion: '0.1.0' },
    entrypoints: { server: 'index' },
  };
}

/**
 * Write a minimal valid local extension fixture.
 * @param rootDir - Extension root.
 * @param name - Descriptor name.
 * @param version - Descriptor version.
 */
async function writeExtension(rootDir: string, name: string, version?: string): Promise<void> {
  await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'src', 'index.ts'), 'export default { name: "test", displayName: "Test" };');
  await fs.writeFile(path.join(rootDir, 'descriptor.json'), JSON.stringify(makeDescriptor(name, version)));
}

describe('LocalPathInstaller', () => {
  let tempDir: string;
  let extensionsDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-installer-test-'));
    extensionsDir = path.join(tempDir, 'extensions');
    sourceDir = path.join(tempDir, 'source');
    await fs.mkdir(sourceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should install a valid local extension via symlink', async () => {
    await writeExtension(sourceDir, 'my-ext');

    const installer = new LocalPathInstaller(extensionsDir);
    const result = await installer.install(sourceDir);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe('my-ext');
    expect(result.version).toBe('1.0.0');
    expect(result.restartRequired).toBe(true);

    // Verify symlink was created
    const linkPath = path.join(extensionsDir, 'my-ext');
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = await fs.readlink(linkPath);
    await expect(fs.realpath(target)).resolves.toBe(await fs.realpath(sourceDir));
  });

  it('should reject path without descriptor.json', async () => {
    // sourceDir exists but has no descriptor.json
    const installer = new LocalPathInstaller(extensionsDir);
    const result = await installer.install(sourceDir);

    expect(result.success).toBe(false);
    expect(result.packageName).toBe('');
    expect(result.error).toBeDefined();
    expect(result.restartRequired).toBe(false);
  });

  it('should reject invalid descriptor', async () => {
    await fs.writeFile(
      path.join(sourceDir, 'descriptor.json'),
      JSON.stringify({ name: 'broken' /* missing required fields */ }),
    );

    const installer = new LocalPathInstaller(extensionsDir);
    const result = await installer.install(sourceDir);

    expect(result.success).toBe(false);
    expect(result.packageName).toBe('');
    expect(result.error).toBeDefined();
    expect(result.restartRequired).toBe(false);
  });

  it('should uninstall by removing the symlink', async () => {
    await writeExtension(sourceDir, 'my-ext');

    const installer = new LocalPathInstaller(extensionsDir);
    await installer.install(sourceDir);

    const linkPath = path.join(extensionsDir, 'my-ext');
    // Confirm link exists before uninstall
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    const result = await installer.uninstall('my-ext');
    expect(result.success).toBe(true);
    expect(result.packageName).toBe('my-ext');

    // Confirm link is gone
    await expect(fs.lstat(linkPath)).rejects.toThrow();
  });

  it('should reject uninstall names that escape the extensions directory', async () => {
    const outsidePath = path.join(tempDir, 'outside');
    await fs.writeFile(outsidePath, 'do not remove');

    const installer = new LocalPathInstaller(extensionsDir);
    const result = await installer.uninstall('../outside');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid extension name');
    await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('do not remove');
  });

  it('should list locally installed extensions', async () => {
    await writeExtension(sourceDir, 'my-ext', '2.3.4');

    const installer = new LocalPathInstaller(extensionsDir);
    await installer.install(sourceDir);

    const entries = await installer.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('my-ext');
    expect(entries[0].version).toBe('2.3.4');
    expect(entries[0].sourcePath).toBe(await fs.realpath(sourceDir));
    expect(entries[0].source).toBe('local');
  });

  it('should resolve descriptor.json path to parent directory', async () => {
    await writeExtension(sourceDir, 'my-ext');

    const installer = new LocalPathInstaller(extensionsDir);
    const descriptorPath = path.join(sourceDir, 'descriptor.json');
    const result = await installer.install(descriptorPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe('my-ext');

    const linkPath = path.join(extensionsDir, 'my-ext');
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('should handle scoped extension names in symlink path', async () => {
    await writeExtension(sourceDir, '@acme/weather-tools');

    const installer = new LocalPathInstaller(extensionsDir);
    const result = await installer.install(sourceDir);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe('@acme/weather-tools');

    // Symlink should be at extensionsDir/@acme/weather-tools
    const linkPath = path.join(extensionsDir, '@acme', 'weather-tools');
    const stat = await fs.lstat(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = await fs.readlink(linkPath);
    await expect(fs.realpath(target)).resolves.toBe(await fs.realpath(sourceDir));
  });

  it('should return empty array when extensionsDir does not exist', async () => {
    const installer = new LocalPathInstaller(path.join(tempDir, 'nonexistent'));
    const entries = await installer.list();
    expect(entries).toEqual([]);
  });

  it('should reject descriptors whose entrypoint cannot be resolved', async () => {
    await fs.writeFile(path.join(sourceDir, 'descriptor.json'), JSON.stringify(makeDescriptor('missing-entry')));

    const installer = new LocalPathInstaller(extensionsDir);
    const result = await installer.install(sourceDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('has no resolvable candidate');
  });

  it('should create absolute symlinks for relative source paths', async () => {
    await writeExtension(sourceDir, 'relative-ext');
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const installer = new LocalPathInstaller(extensionsDir);
      const result = await installer.install('./source');

      expect(result.success).toBe(true);
      const target = await fs.readlink(path.join(extensionsDir, 'relative-ext'));
      expect(path.isAbsolute(target)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

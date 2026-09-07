/**
 * Export boundary tests for the `@makaio/cli/install-transaction` subpath.
 *
 * Verifies that the narrow public subpath exports only the transaction-level
 * helpers and types, not CLI command registration functions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  // Fail on module evaluation, not merely on accessing a runtime export.
  vi.doMock('@makaio/runtime-node', () => {
    throw new Error('The transaction entrypoint must not evaluate the runtime root.');
  });
});

afterEach(() => {
  vi.doUnmock('@makaio/runtime-node');
  vi.doUnmock('@makaio/utils/project-manifest');
  vi.resetModules();
});

describe('@makaio/cli/install-transaction subpath export', () => {
  it('exports transaction helpers without loading the runtime root or command registration', async () => {
    const mod = await import('@makaio/cli/install-transaction');

    expect(typeof mod.installExtensionSources).toBe('function');
    expect(typeof mod.installProjectExtensions).toBe('function');
    expect('registerExtensionCommands' in mod).toBe(false);
    expect('registerInstallCommand' in mod).toBe(false);
  }, 15_000);

  it('throws when no project manifest is found', async () => {
    vi.doMock('@makaio/utils/project-manifest', () => ({
      findProjectManifestPath: vi.fn(async () => null),
      readProjectManifest: vi.fn(),
    }));
    const { installProjectExtensions } = await import('../install-transaction-public.js');

    await expect(installProjectExtensions()).rejects.toThrow(
      'No .makaio/manifest.json found from the current directory.',
    );
  });

  it('treats blank manifest paths like omitted manifest paths', async () => {
    const findProjectManifestPath = vi.fn(async () => null);
    vi.doMock('@makaio/utils/project-manifest', () => ({
      findProjectManifestPath,
      readProjectManifest: vi.fn(),
    }));
    const { installProjectExtensions } = await import('../install-transaction-public.js');

    await expect(installProjectExtensions('   ')).rejects.toThrow(
      'No .makaio/manifest.json found from the current directory.',
    );
    expect(findProjectManifestPath).toHaveBeenCalledWith(process.cwd());
  });
});

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { safeParseExtensionDescriptor } from '@makaio/contracts';
import type { PackageRegistry } from '../namespace.js';
import { PackageRegistrySchema } from '../namespace.js';
import { DescriptorNameResolver } from '../descriptor-name-resolver.js';

const registry: PackageRegistry = {
  $schema: 'makaio/package-registry/v1',
  updatedAt: '2026-05-17T00:00:00Z',
  adapters: [
    {
      name: '@makaio/adapter-claude-code-tmux',
      descriptorName: 'claude-code-tmux',
      displayName: 'Claude Code tmux',
      description: 'Claude Code via tmux',
    },
    {
      name: '@makaio/provider-anthropic',
      descriptorName: 'provider-anthropic',
      displayName: 'Anthropic',
      description: 'Anthropic provider definition',
    },
  ],
  extensions: [
    {
      name: '@makaio/provider-anthropic',
      descriptorName: 'provider-anthropic',
      displayName: 'Anthropic Provider',
      description: 'Anthropic provider definitions',
    },
    {
      name: '@makaio/client-claude-code',
      descriptorName: 'claude-code',
      displayName: 'Claude Code',
      description: 'Claude Code client definition',
    },
    {
      name: '@makaio/extension-client-hooks',
      descriptorName: 'client-hooks',
      displayName: 'Client Hooks',
      description: 'Client hook extension definition',
    },
    {
      name: '@makaio/extension-claude-code-statusline',
      descriptorName: 'claude-code-statusline',
      displayName: 'Claude Code Statusline',
      description: 'Claude Code statusline extension definition',
    },
  ],
};

/**
 * Check whether a filesystem path exists.
 * @param filePath - Absolute path to probe.
 * @returns True when the path is accessible.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the nearest package root from a source or test directory.
 * @param startDir - Absolute directory to start searching from.
 * @returns Absolute package root path.
 */
async function findPackageRoot(startDir: string): Promise<string> {
  let currentDir = startDir;

  while (true) {
    if (await fileExists(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find package root from ${startDir}.`);
    }
    currentDir = parentDir;
  }
}

/**
 * Resolve a workspace-relative file from this test package's workspace root.
 * @param startDir - Absolute directory to start searching from.
 * @param relativePath - Path relative to the workspace root.
 * @returns Absolute path to the resolved file.
 */
async function findWorkspaceFile(startDir: string, relativePath: string): Promise<string> {
  const packageRoot = await findPackageRoot(startDir);
  const workspaceRoot = path.resolve(packageRoot, '../../..');
  const filePath = path.join(workspaceRoot, relativePath);

  if (await fileExists(filePath)) {
    return filePath;
  }

  throw new Error(`Could not find ${relativePath} from ${workspaceRoot}.`);
}

async function readRegistryForCurrentCheckout(): Promise<PackageRegistry> {
  const packageRoot = await findPackageRoot(import.meta.dirname);
  const workspaceRoot = path.resolve(packageRoot, '../../..');
  const monorepoRegistryPath = path.join(workspaceRoot, '../registry/packages.json');

  try {
    const registryRaw = JSON.parse(await fs.readFile(monorepoRegistryPath, 'utf-8')) as unknown;
    return PackageRegistrySchema.parse(registryRaw);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return registry;
    }
    throw error;
  }
}

describe('DescriptorNameResolver', () => {
  it('resolves descriptor names from registry metadata', async () => {
    const resolver = new DescriptorNameResolver({ getRegistry: async () => registry });

    await expect(resolver.resolveNpmPackageName('claude-code')).resolves.toBe('@makaio/client-claude-code');
  });

  it('passes scoped descriptor names through when no registry entry exists', async () => {
    const resolver = new DescriptorNameResolver({ getRegistry: async () => registry });

    await expect(resolver.resolveNpmPackageName('@acme/weather-tools')).resolves.toBe('@acme/weather-tools');
  });

  it('falls back to @makaio convention for unmapped unscoped names', async () => {
    const resolver = new DescriptorNameResolver({ getRegistry: async () => registry });

    await expect(resolver.resolveNpmPackageName('provider-unmapped')).resolves.toBe('@makaio/provider-unmapped');
  });

  it('uses scoped fallback when the registry fetch fails', async () => {
    const resolver = new DescriptorNameResolver({
      getRegistry: async () => {
        throw new Error('registry unavailable');
      },
    });

    await expect(resolver.resolveNpmPackageName('@acme/weather-tools')).resolves.toBe('@acme/weather-tools');
  });

  it('throws for unscoped names when the registry fetch fails', async () => {
    const resolver = new DescriptorNameResolver({
      getRegistry: async () => {
        throw new Error('registry unavailable');
      },
    });

    await expect(resolver.resolveNpmPackageName('provider-anthropic')).rejects.toThrow(
      /package registry is unavailable/,
    );
  });

  it('retries registry fetch after a transient failure', async () => {
    let calls = 0;
    const resolver = new DescriptorNameResolver({
      getRegistry: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('registry unavailable');
        }
        return registry;
      },
    });

    await expect(resolver.resolveNpmPackageName('provider-anthropic')).rejects.toThrow(
      /package registry is unavailable/,
    );
    await expect(resolver.resolveNpmPackageName('claude-code')).resolves.toBe('@makaio/client-claude-code');
    expect(calls).toBe(2);
  });

  it('caches the registry promise for one resolver instance', async () => {
    let calls = 0;
    const resolver = new DescriptorNameResolver({
      getRegistry: async () => {
        calls += 1;
        return registry;
      },
    });

    await resolver.resolveNpmPackageName('claude-code');
    await resolver.resolveNpmPackageName('claude-code-tmux');

    expect(calls).toBe(1);
  });

  it('maps every Claude Code tmux descriptor dependency through registry metadata', async () => {
    const actualRegistry = await readRegistryForCurrentCheckout();
    const descriptorPath = await findWorkspaceFile(
      import.meta.dirname,
      'adapters/implementations/claude-code-tmux/descriptor.json',
    );
    const descriptorRaw = JSON.parse(await fs.readFile(descriptorPath, 'utf-8')) as unknown;
    const descriptorResult = safeParseExtensionDescriptor(descriptorRaw);
    expect(descriptorResult.success).toBe(true);
    if (!descriptorResult.success) return;

    const resolver = new DescriptorNameResolver({ getRegistry: async () => actualRegistry });
    const resolved = await Promise.all(
      (descriptorResult.data.dependencies ?? []).map(async (dependency) => [
        dependency.name,
        await resolver.resolveNpmPackageName(dependency.name),
      ]),
    );

    expect(Object.fromEntries(resolved)).toEqual({
      'provider-anthropic': '@makaio/provider-anthropic',
      'claude-code': '@makaio/client-claude-code',
      'client-hooks': '@makaio/extension-client-hooks',
      'claude-code-statusline': '@makaio/extension-claude-code-statusline',
    });
  });
});

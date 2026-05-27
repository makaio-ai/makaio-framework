import { describe, expect, it } from 'vitest';
import {
  CliArgManifestSchema,
  CliManifestSchema,
  CliSubcommandManifestSchema,
  ExtensionDependencySchema,
  ExtensionManifestSchema,
  RuntimeRequirementSchema,
  WindowManifestSchema,
  WindowParamSpecSchema,
} from '../manifest.js';

const baseManifest = {
  name: 'my-extension',
  displayName: 'My Extension',
  version: '1.0.0',
};

describe('ExtensionManifestSchema', () => {
  it('accepts a valid minimal manifest', () => {
    const result = ExtensionManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('rejects a manifest with missing version', () => {
    const result = ExtensionManifestSchema.safeParse({ name: 'my-extension', displayName: 'My Extension' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid full manifest', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      surface: 'interactive',
      dependencies: [{ type: 'extension', name: 'account-manager', version: '>=1.0.0' }],
      windows: [
        {
          id: 'main',
          style: 'utility',
          width: 400,
          height: 300,
          singleton: true,
          params: [{ name: 'projectId', required: true }],
        },
      ],
      tray: { label: 'My Extension', section: 'tools', opensWindow: 'main' },
      cli: {
        name: 'my-ext',
        description: 'My extension CLI',
        subcommands: [
          {
            name: 'run',
            description: 'Run the extension',
            args: [{ name: 'target', description: 'Target to run', required: true }],
          },
        ],
      },
      storage: { migrations: 'drizzle', migrationSourceId: 'packages/my-extension/drizzle' },
      // BrowserEntrypointSchema uses `entrypoint` (not `path`) — see browser-entrypoint.ts
      browser: { entrypoint: '/extensions/my-extension/browser/index.js' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a manifest with missing name', () => {
    const result = ExtensionManifestSchema.safeParse({ displayName: 'My Extension' });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest with empty name', () => {
    const result = ExtensionManifestSchema.safeParse({ name: '', displayName: 'My Extension' });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest with missing displayName', () => {
    const result = ExtensionManifestSchema.safeParse({ name: 'my-extension' });
    expect(result.success).toBe(false);
  });

  it('rejects a manifest with empty displayName', () => {
    const result = ExtensionManifestSchema.safeParse({ name: 'my-extension', displayName: '' });
    expect(result.success).toBe(false);
  });

  it('rejects blank provides entries', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      provides: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only provides entries', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      provides: ['   '],
    });
    expect(result.success).toBe(false);
  });

  it('rejects legacy storage migrations array form', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      storage: { migrations: ['migrations/001_init.sql'] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects absolute storage migrations paths', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      storage: { migrations: '/abs/drizzle' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects parent-directory storage migrations paths', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      storage: { migrations: '../drizzle' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects drive-prefixed storage migrations paths', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      storage: { migrations: 'C:drizzle' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts storage migrations without migrationSourceId', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      storage: { migrations: 'drizzle' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty migrationSourceId', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      storage: { migrations: 'drizzle', migrationSourceId: '' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts structured extension dependencies', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      dependencies: [{ type: 'extension', name: 'auth-manager', version: '^2.0.0' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional structured dependencies', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      dependencies: [{ type: 'extension', name: 'auth-manager', version: '>=1.0.0', optional: true }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects plain string dependencies', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      dependencies: ['account-manager'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a host requirement in requires', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      requires: [{ type: 'host', id: 'node' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a capability requirement in requires', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      requires: [{ type: 'capability', id: 'storage.drizzle' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a capability requirement with a version range in requires', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      requires: [{ type: 'capability', id: 'storage.drizzle', version: '>=1.0.0' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects plain string requires on manifest', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      requires: ['node'],
    });
    expect(result.success).toBe(false);
  });
});

describe('ExtensionDependencySchema', () => {
  it('accepts a valid minimal dependency', () => {
    const result = ExtensionDependencySchema.safeParse({
      type: 'extension',
      name: 'account-manager',
      version: '>=1.0.0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a dependency with optional: true', () => {
    const result = ExtensionDependencySchema.safeParse({
      type: 'extension',
      name: 'account-manager',
      version: '^1.5.0',
      optional: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a dependency with wrong type discriminant', () => {
    const result = ExtensionDependencySchema.safeParse({
      type: 'package',
      name: 'account-manager',
      version: '>=1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a dependency with empty name', () => {
    const result = ExtensionDependencySchema.safeParse({
      type: 'extension',
      name: '',
      version: '>=1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a dependency with an invalid version range', () => {
    const result = ExtensionDependencySchema.safeParse({
      type: 'extension',
      name: 'account-manager',
      version: 'not-a-semver',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a dependency with a missing version', () => {
    const result = ExtensionDependencySchema.safeParse({
      type: 'extension',
      name: 'account-manager',
    });
    expect(result.success).toBe(false);
  });
});

describe('RuntimeRequirementSchema', () => {
  it('accepts a host requirement', () => {
    const result = RuntimeRequirementSchema.safeParse({ type: 'host', id: 'node' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ type: 'host', id: 'node' });
    }
  });

  it('accepts a capability requirement without version', () => {
    const result = RuntimeRequirementSchema.safeParse({ type: 'capability', id: 'storage.drizzle' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ type: 'capability', id: 'storage.drizzle' });
    }
  });

  it('accepts a capability requirement with a valid semver version range', () => {
    const result = RuntimeRequirementSchema.safeParse({
      type: 'capability',
      id: 'storage.drizzle',
      version: '>=1.0.0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ type: 'capability', id: 'storage.drizzle', version: '>=1.0.0' });
    }
  });

  it('rejects a capability requirement with an invalid version range', () => {
    const result = RuntimeRequirementSchema.safeParse({
      type: 'capability',
      id: 'storage.drizzle',
      version: 'not-a-semver',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a host requirement with an empty id', () => {
    const result = RuntimeRequirementSchema.safeParse({ type: 'host', id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a capability requirement with an empty id', () => {
    const result = RuntimeRequirementSchema.safeParse({ type: 'capability', id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown type discriminant', () => {
    const result = RuntimeRequirementSchema.safeParse({ type: 'platform', id: 'linux' });
    expect(result.success).toBe(false);
  });

  it('rejects a plain string (legacy format)', () => {
    const result = RuntimeRequirementSchema.safeParse('node');
    expect(result.success).toBe(false);
  });
});

describe('WindowParamSpecSchema', () => {
  it('accepts a valid window param spec', () => {
    const result = WindowParamSpecSchema.safeParse({ name: 'projectId', required: true });
    expect(result.success).toBe(true);
  });

  it('rejects an empty window param name', () => {
    const result = WindowParamSpecSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('CliManifestSchema', () => {
  it('accepts a valid CLI manifest without subcommands', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid CLI manifest with subcommands', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      subcommands: [
        { name: 'list', description: 'List items' },
        { name: 'add', description: 'Add an item' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a subcommand with args', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      subcommands: [
        {
          name: 'deploy',
          description: 'Deploy to environment',
          args: [
            { name: 'env', description: 'Target environment', required: true, positional: true },
            { name: 'profile', description: 'AWS profile', short: '-p' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a CLI manifest with missing name', () => {
    const result = CliManifestSchema.safeParse({ description: 'My command' });
    expect(result.success).toBe(false);
  });

  it('rejects a CLI manifest with missing description', () => {
    const result = CliManifestSchema.safeParse({ name: 'my-cmd' });
    expect(result.success).toBe(false);
  });

  it('accepts hasInteractive: true', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      hasInteractive: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hasInteractive).toBe(true);
    }
  });

  it('accepts hasInteractive: false', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      hasInteractive: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a manifest without the hasInteractive field (optional)', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hasInteractive).toBeUndefined();
    }
  });

  it('rejects hasInteractive with a non-boolean value', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      hasInteractive: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('accepts canProvideBus: true', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      canProvideBus: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.canProvideBus).toBe(true);
    }
  });

  it('accepts canProvideBus: false', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      canProvideBus: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects canProvideBus with a non-boolean value', () => {
    const result = CliManifestSchema.safeParse({
      name: 'my-cmd',
      description: 'My command',
      canProvideBus: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a CLI manifest with empty name', () => {
    const result = CliManifestSchema.safeParse({ name: '', description: 'My command' });
    expect(result.success).toBe(false);
  });
});

describe('CliArgManifestSchema', () => {
  it('accepts a valid arg without type field', () => {
    const result = CliArgManifestSchema.safeParse({ name: 'profile', description: 'Profile name' });
    expect(result.success).toBe(true);
  });

  it('accepts type: boolean', () => {
    const result = CliArgManifestSchema.safeParse({
      name: 'verbose',
      description: 'Enable verbose output',
      type: 'boolean',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type: string', () => {
    const result = CliArgManifestSchema.safeParse({
      name: 'format',
      description: 'Output format',
      type: 'string',
    });
    expect(result.success).toBe(true);
  });

  it('accepts type: number', () => {
    const result = CliArgManifestSchema.safeParse({
      name: 'count',
      description: 'Number of items',
      type: 'number',
    });
    expect(result.success).toBe(true);
  });

  it('rejects type: invalid', () => {
    const result = CliArgManifestSchema.safeParse({
      name: 'flag',
      description: 'A flag',
      type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an arg with empty name', () => {
    const result = CliArgManifestSchema.safeParse({ name: '', description: 'Empty' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid short flag format', () => {
    const result = CliArgManifestSchema.safeParse({
      name: 'verbose',
      description: 'Verbose',
      short: '--verbose', // should be -v format
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid short flag', () => {
    const result = CliArgManifestSchema.safeParse({
      name: 'verbose',
      description: 'Verbose',
      short: '-v',
    });
    expect(result.success).toBe(true);
  });
});

describe('CliSubcommandManifestSchema', () => {
  it('rejects a subcommand with empty name', () => {
    const result = CliSubcommandManifestSchema.safeParse({ name: '', description: 'Empty' });
    expect(result.success).toBe(false);
  });
});

describe('WindowManifestSchema', () => {
  it('accepts a valid minimal window', () => {
    const result = WindowManifestSchema.safeParse({ id: 'main', style: 'utility' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid full window', () => {
    const result = WindowManifestSchema.safeParse({
      id: 'popover',
      style: 'tray-popover',
      width: 320,
      height: 480,
      singleton: true,
      params: [{ name: 'projectId', required: true }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a window with invalid style enum', () => {
    const result = WindowManifestSchema.safeParse({ id: 'main', style: 'fullscreen' });
    expect(result.success).toBe(false);
  });

  it('rejects a window with missing id', () => {
    const result = WindowManifestSchema.safeParse({ style: 'panel' });
    expect(result.success).toBe(false);
  });

  it('rejects a window with missing style', () => {
    const result = WindowManifestSchema.safeParse({ id: 'main' });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate window param names', () => {
    const result = WindowManifestSchema.safeParse({
      id: 'project',
      style: 'utility',
      params: [{ name: 'projectId' }, { name: 'projectId', required: true }],
    });
    expect(result.success).toBe(false);
  });
});

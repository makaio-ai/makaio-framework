import { describe, expect, it } from 'vitest';
import {
  CliArgManifestSchema,
  CliManifestSchema,
  CliSubcommandManifestSchema,
  ExtensionManifestSchema,
  WindowManifestSchema,
  WindowParamSpecSchema,
} from '../manifest.js';

const baseManifest = {
  name: 'my-extension',
  displayName: 'My Extension',
};

describe('ExtensionManifestSchema', () => {
  it('accepts a valid minimal manifest', () => {
    const result = ExtensionManifestSchema.safeParse(baseManifest);
    expect(result.success).toBe(true);
  });

  it('accepts a valid full manifest', () => {
    const result = ExtensionManifestSchema.safeParse({
      ...baseManifest,
      surface: 'interactive',
      dependencies: ['account-manager'],
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
      storage: { migrations: 'drizzle', migrationSourceId: 'framework/packages/my-extension/drizzle' },
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

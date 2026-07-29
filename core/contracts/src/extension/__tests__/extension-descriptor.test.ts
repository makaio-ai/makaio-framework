import { describe, expect, it } from 'vitest';
import { ExtensionDescriptorSchema } from '../extension-descriptor.js';

const baseDescriptor = {
  name: 'my-extension',
  displayName: 'My Extension',
  version: '1.0.0',
  makaio: { framework: '>=2.0.0' },
  entrypoints: { server: true },
};

describe('ExtensionDescriptorSchema', () => {
  it('accepts a valid minimal descriptor', () => {
    const result = ExtensionDescriptorSchema.safeParse(baseDescriptor);
    expect(result.success).toBe(true);
  });

  it('accepts a valid full descriptor', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      surface: 'headless',
      dependencies: [{ type: 'extension', name: 'account-manager', version: '>=1.0.0' }],
      entrypoints: {
        server: true,
        browser: 'browser/index',
        cli: 'cli/index',
      },
      execution: 'embedded',
      config: { defaults: { theme: 'dark' } },
      cli: { name: 'my-ext', description: 'My extension CLI' },
    });
    expect(result.success).toBe(true);
  });

  it('allows extra unknown fields', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      unknownTopLevelField: 'should be allowed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a descriptor with missing version', () => {
    const { version: _version, ...withoutVersion } = baseDescriptor;
    const result = ExtensionDescriptorSchema.safeParse(withoutVersion);
    expect(result.success).toBe(false);
  });

  it('rejects a descriptor with empty version', () => {
    const result = ExtensionDescriptorSchema.safeParse({ ...baseDescriptor, version: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a descriptor with missing makaio.framework', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      makaio: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a descriptor with empty makaio.framework', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      makaio: { framework: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a descriptor with an invalid semver range in makaio.framework', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      makaio: { framework: 'not-a-range' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts makaio.framework as a compound range', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      makaio: { framework: '>=1.0.0 <2.0.0' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a descriptor with missing entrypoints', () => {
    const { entrypoints: _entrypoints, ...withoutEntrypoints } = baseDescriptor;
    const result = ExtensionDescriptorSchema.safeParse(withoutEntrypoints);
    expect(result.success).toBe(false);
  });

  it('rejects a descriptor with an empty entrypoints object', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects an absolute entrypoint path', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: '/dist/server.js' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a parent-traversing entrypoint path', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: '../dist/server.js' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects legacy relative path strings for convention entrypoints', () => {
    const serverResult = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: './src/server.ts' },
    });
    const browserResult = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { browser: './dist/browser.mjs' },
    });

    expect(serverResult.success).toBe(false);
    expect(browserResult.success).toBe(false);
  });

  it('rejects dotted final path segments in entrypoint stems', () => {
    const tsxResult = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: 'server.tsx' },
    });
    const mtsResult = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { cli: 'nested/cli.mts' },
    });

    expect(tsxResult.success).toBe(false);
    expect(mtsResult.success).toBe(false);
  });

  it('rejects traversal segments inside an entrypoint stem', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: 'nested/../server' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects platform-specific separators in entrypoint stems', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: 'nested\\server' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects convention-owned src and dist segments in entrypoint stems', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { browser: 'browser/dist/index' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts execution: embedded', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      execution: 'embedded',
    });
    expect(result.success).toBe(true);
  });

  it('accepts execution: detached with a transport config and no entrypoints', () => {
    const { entrypoints: _entrypoints, ...withoutEntrypoints } = baseDescriptor;
    const result = ExtensionDescriptorSchema.safeParse({
      ...withoutEntrypoints,
      execution: 'detached',
      transport: { type: 'bus-stdio', command: 'node' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects execution: detached when entrypoints are declared', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      execution: 'detached',
      transport: { type: 'bus-stdio', command: 'node' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid execution value', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      execution: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('inherits ExtensionManifest validation — rejects missing name', () => {
    const { name: _name, ...withoutName } = baseDescriptor;
    const result = ExtensionDescriptorSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  it('inherits ExtensionManifest validation — rejects empty displayName', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      displayName: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts config with defaults', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      config: { defaults: { enabled: true } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts config as empty object (defaults is optional)', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      config: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts descriptor with config omitted', () => {
    const result = ExtensionDescriptorSchema.safeParse(baseDescriptor);
    expect(result.success).toBe(true);
  });

  it('rejects config as a string', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      config: 'string',
    });
    expect(result.success).toBe(false);
  });

  it('rejects config.defaults as a non-object value', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      config: { defaults: 'not-an-object' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts prebundleDependencies alongside a browser entrypoint', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: true, browser: true },
      prebundleDependencies: ['react-use', 'shiki'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects blank prebundleDependencies entries', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      entrypoints: { server: true, browser: true },
      prebundleDependencies: ['   '],
    });
    expect(result.success).toBe(false);
  });

  it('rejects prebundleDependencies without a browser entrypoint', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      prebundleDependencies: ['react-use'],
    });
    expect(result.success).toBe(false);
  });
});

describe('legacy field rejection', () => {
  it('rejects descriptor with minVersion instead of framework', () => {
    // minVersion is the old field name; Zod strips unknown keys, so the
    // required `framework` field is absent and parsing must fail.
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      makaio: { minVersion: '0.1.0' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects descriptor when legacy minVersion is present alongside framework', () => {
    const result = ExtensionDescriptorSchema.safeParse({
      ...baseDescriptor,
      makaio: { framework: '>=2.0.0', minVersion: '0.1.0' },
    });
    expect(result.success).toBe(false);
  });
});

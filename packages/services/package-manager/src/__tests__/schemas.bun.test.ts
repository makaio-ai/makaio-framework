import { describe, it, expect } from 'bun:test';
import {
  PackageInstallResultSchema,
  PackageInfoSchema,
  PackageRegistrySchema,
  PackageManagementSchemas,
  ResolvedPackageSchema,
  SkippedPackageSchema,
} from '../schemas.js';

describe('PackageManagementSchemas', () => {
  it('should validate a successful install result', () => {
    const result = PackageInstallResultSchema.parse({
      success: true,
      packageName: '@acme/weather-tools',
      version: '1.2.0',
      restartRequired: true,
    });
    expect(result.success).toBe(true);
  });

  it('should validate package info with hasDescriptor', () => {
    const info = PackageInfoSchema.parse({
      name: '@acme/weather-tools',
      version: '1.0.0',
      hasDescriptor: true,
    });
    expect(info.hasDescriptor).toBe(true);
  });

  it('should default hasDescriptor to false', () => {
    const info = PackageInfoSchema.parse({
      name: '@acme/weather-tools',
      version: '1.0.0',
    });
    expect(info.hasDescriptor).toBe(false);
  });

  it('should use extensions field name in PackageRegistrySchema', () => {
    const registry = PackageRegistrySchema.parse({
      $schema: 'makaio/package-registry/v1',
      updatedAt: '2026-01-31T12:00:00Z',
      adapters: [],
      extensions: [],
    });
    expect(registry.extensions).toEqual([]);
  });

  it('should reject registry with plugins field', () => {
    const result = PackageRegistrySchema.safeParse({
      $schema: 'makaio/package-registry/v1',
      updatedAt: '2026-01-31T12:00:00Z',
      adapters: [],
      plugins: [],
    });
    expect(result.success).toBe(false);
  });

  it('should expose all expected subject keys', () => {
    const keys = Object.keys(PackageManagementSchemas);
    expect(keys).toContain('list');
    expect(keys).toContain('install');
    expect(keys).toContain('uninstall');
    expect(keys).toContain('installed');
    expect(keys).toContain('uninstalled');
  });

  it('should accept install request with optional source field', () => {
    const schemas = PackageManagementSchemas.install;
    const result = schemas.request.parse({ packageNames: ['@acme/ext'], source: 'local' });
    expect(result.source).toBe('local');
  });

  it('should accept install request without source field', () => {
    const schemas = PackageManagementSchemas.install;
    const result = schemas.request.parse({ packageNames: ['@acme/ext'] });
    expect(result.source).toBeUndefined();
  });

  it('accepts backward-compatible single packageName install requests', () => {
    const result = PackageManagementSchemas.install.request.parse({ packageName: '@acme/ext' });
    expect(result.packageName).toBe('@acme/ext');
  });

  it('accepts registry package descriptorName metadata', () => {
    const registry = PackageRegistrySchema.parse({
      $schema: 'makaio/package-registry/v1',
      updatedAt: '2026-05-17T00:00:00Z',
      adapters: [
        {
          name: '@makaio/adapter-claude-code-tmux',
          descriptorName: 'claude-code-tmux',
          displayName: 'Claude Code tmux',
          description: 'Claude Code via tmux',
        },
      ],
      extensions: [],
    });

    expect(registry.adapters[0]?.descriptorName).toBe('claude-code-tmux');
  });

  it('accepts batch install request fields', () => {
    const result = PackageManagementSchemas.install.request.parse({
      packageNames: ['@makaio/adapter-claude-code-tmux', '@makaio/extension-prompt'],
      force: true,
    });

    expect(result.packageNames).toHaveLength(2);
    expect(result.force).toBe(true);
  });

  it('accepts install result with dependency resolution details', () => {
    const result = PackageInstallResultSchema.parse({
      success: true,
      packageName: '@makaio/adapter-claude-code-tmux',
      version: '0.1.0',
      restartRequired: true,
      installed: [{ npmName: '@makaio/provider-anthropic', version: '0.1.0', source: 'new' }],
      skipped: [{ npmName: '@makaio/optional-helper', reason: 'not found' }],
      warnings: ['Resolved provider-anthropic by convention as @makaio/provider-anthropic'],
    });

    expect(result.installed).toHaveLength(1);
  });

  it('validates ResolvedPackageSchema source enum', () => {
    const resolved = ResolvedPackageSchema.parse({
      npmName: '@makaio/adapter-claude-code-tmux',
      version: '0.1.0',
      source: 'already-present',
    });

    expect(resolved.source).toBe('already-present');
  });

  it('validates SkippedPackageSchema', () => {
    const skipped = SkippedPackageSchema.parse({
      npmName: '@makaio/optional-pkg',
      reason: 'network timeout',
    });

    expect(skipped.npmName).toBe('@makaio/optional-pkg');
  });

  it('rejects install request with empty packageNames', () => {
    const result = PackageManagementSchemas.install.request.safeParse({ packageNames: [] });
    expect(result.success).toBe(false);
  });

  it('rejects install request without packageName or packageNames', () => {
    const result = PackageManagementSchemas.install.request.safeParse({});
    expect(result.success).toBe(false);
  });
});

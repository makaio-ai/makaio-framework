import { describe, it, expect } from 'vitest';
import {
  PackageInstallResultSchema,
  PackageInfoSchema,
  PackageRegistrySchema,
  PackageManagementSchemas,
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
    const result = schemas.request.parse({ packageName: '@acme/ext', source: 'local' });
    expect(result.source).toBe('local');
  });

  it('should accept install request without source field', () => {
    const schemas = PackageManagementSchemas.install;
    const result = schemas.request.parse({ packageName: '@acme/ext' });
    expect(result.source).toBeUndefined();
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { BundledSeedFetcher } from '../bundled-seed-fetcher.js';

/** Minimal valid registry YAML fixture. */
const validRegistryYaml = `\
$schema: makaio/model-registry/v2
updatedAt: "2026-01-30T12:00:00.000Z"
labs:
  test:
    name: Test Lab
    models:
      - name: test-model
        friendlyName: Test Model
        contextWindowSize: 8000
        labId: test
providers:
  test:
    name: Test Provider
    models:
      test-model: {}
`;

describe('BundledSeedFetcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bundled-seed-fetcher-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a single valid candidate', async () => {
    const seedPath = path.join(tmpDir, 'model-registry.yaml');
    await fs.promises.writeFile(seedPath, validRegistryYaml, 'utf-8');

    const registry = await new BundledSeedFetcher(seedPath).fetch();

    expect(registry.$schema).toBe('makaio/model-registry/v2');
    expect(registry.labs.test?.models[0]?.name).toBe('test-model');
    expect(registry.providers.test?.name).toBe('Test Provider');
  });

  it('falls through to the second candidate when the first is missing', async () => {
    const missingPath = path.join(tmpDir, 'nonexistent.yaml');
    const validPath = path.join(tmpDir, 'model-registry.yaml');
    await fs.promises.writeFile(validPath, validRegistryYaml, 'utf-8');

    const registry = await new BundledSeedFetcher([missingPath, validPath]).fetch();

    expect(registry.labs.test?.models[0]?.name).toBe('test-model');
  });

  it('throws with a descriptive error listing all tried paths when all candidates are missing', async () => {
    const first = path.join(tmpDir, 'first.yaml');
    const second = path.join(tmpDir, 'second.yaml');

    await expect(new BundledSeedFetcher([first, second]).fetch()).rejects.toThrow(
      /Bundled model registry seed not found.*Tried/s,
    );
    await expect(new BundledSeedFetcher([first, second]).fetch()).rejects.toThrow(first);
    await expect(new BundledSeedFetcher([first, second]).fetch()).rejects.toThrow(second);
  });

  it('throws wrapping the parse error when the seed file contains invalid YAML', async () => {
    const seedPath = path.join(tmpDir, 'bad.yaml');
    // Write YAML that parses successfully but fails schema validation
    await fs.promises.writeFile(seedPath, '{ not_valid_registry: true }', 'utf-8');

    await expect(new BundledSeedFetcher(seedPath).fetch()).rejects.toThrow(/Invalid bundled model registry seed/);
  });

  it('treats an ENOTDIR path (file as directory component) as a missing candidate and falls through', async () => {
    // Create a file at `tmpDir/file.yaml`, then reference `tmpDir/file.yaml/seed.yaml`
    // so that one path component is a file — triggers ENOTDIR.
    const fileAsDir = path.join(tmpDir, 'file.yaml');
    await fs.promises.writeFile(fileAsDir, 'not a dir', 'utf-8');
    const enotdirPath = path.join(fileAsDir, 'seed.yaml');

    const validPath = path.join(tmpDir, 'model-registry.yaml');
    await fs.promises.writeFile(validPath, validRegistryYaml, 'utf-8');

    // The ENOTDIR candidate is silently skipped; the valid fallback is used.
    const registry = await new BundledSeedFetcher([enotdirPath, validPath]).fetch();

    expect(registry.labs.test?.models[0]?.name).toBe('test-model');
  });

  it('rejects an invalid registry structure that fails schema validation', async () => {
    const seedPath = path.join(tmpDir, 'invalid-schema.yaml');
    // Produce a YAML string from an object that violates the schema (missing required fields).
    const invalidPayload = stringifyYaml({
      $schema: 'makaio/model-registry/v2',
      updatedAt: '2026-01-30T12:00:00.000Z',
      labs: {
        test: {
          name: 'Test Lab',
          models: [
            {
              name: 'test-model',
              friendlyName: 'Test Model',
              // contextWindowSize is required — deliberately omitted to trigger schema error
              labId: 'test',
            },
          ],
        },
      },
      providers: {
        test: {
          name: 'Test Provider',
          models: { 'test-model': {} },
        },
      },
    });
    await fs.promises.writeFile(seedPath, invalidPayload, 'utf-8');

    await expect(new BundledSeedFetcher(seedPath).fetch()).rejects.toThrow(/Invalid bundled model registry seed/);
  });
});

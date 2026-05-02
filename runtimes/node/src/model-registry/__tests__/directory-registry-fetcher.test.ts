import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectoryRegistryFetcher } from '../directory-registry-fetcher.js';
import { YamlRegistryFetcher } from '../yaml-registry-fetcher.js';

describe('DirectoryRegistryFetcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-registry-fetcher-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('merges flat YAML files from the configured user models directory', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'custom-lab.yaml'),
      `\
name: Custom Lab
models:
  - name: custom-model
    friendlyName: Custom Model
    contextWindowSize: 12345
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'custom-provider.yaml'),
      `\
name: Custom Provider
models:
  custom-model:
    metadata:
      includedInSubscription: true
`,
      'utf-8',
    );

    const registry = await new DirectoryRegistryFetcher(tmpDir).fetch();

    expect(registry.labs['custom-lab']?.models).toEqual([
      {
        name: 'custom-model',
        friendlyName: 'Custom Model',
        contextWindowSize: 12345,
        labId: 'custom-lab',
      },
    ]);
    expect(registry.providers['custom-provider']?.models).toEqual({
      'custom-model': {
        metadata: {
          includedInSubscription: true,
        },
      },
    });
    expect(registry.updatedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('merges full registry YAML files from the configured user models directory', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'registry.yaml'),
      `\
$schema: makaio/model-registry/v2
updatedAt: "2026-01-30T12:00:00.000Z"
labs:
  openai:
    name: OpenAI Override
    models:
      - name: gpt-custom
        contextWindowSize: 4096
        labId: openai
providers:
  openai:
    name: OpenAI Provider Override
    models:
      gpt-custom: {}
`,
      'utf-8',
    );

    const registry = await new DirectoryRegistryFetcher(tmpDir).fetch();

    expect(registry.labs.openai?.name).toBe('OpenAI Override');
    expect(registry.providers.openai?.name).toBe('OpenAI Provider Override');
  });

  it('rejects provider-only YAML when used as a standalone registry fetcher', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
models:
  gpt-4o: {}
`,
      'utf-8',
    );

    await expect(new DirectoryRegistryFetcher(tmpDir).fetch()).rejects.toThrow(/gpt-4o/);
  });
});

describe('YamlRegistryFetcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaml-registry-fetcher-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-missing directory read failures', async () => {
    const notDirectory = path.join(tmpDir, 'labs.yaml');
    await fs.writeFile(notDirectory, 'name: Not a directory\n', 'utf-8');

    await expect(new YamlRegistryFetcher(notDirectory, path.join(tmpDir, 'providers')).fetch()).rejects.toThrow(
      `Invalid model registry directory ${notDirectory}`,
    );
  });

  it('uses a deterministic updatedAt for assembled YAML directories', async () => {
    const labsDir = path.join(tmpDir, 'labs');
    const providersDir = path.join(tmpDir, 'providers');
    await fs.mkdir(labsDir);
    await fs.mkdir(providersDir);
    await fs.writeFile(
      path.join(labsDir, 'openai.yaml'),
      `\
name: OpenAI
models:
  - name: gpt-4o
    contextWindowSize: 128000
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(providersDir, 'openai.yaml'),
      `\
name: OpenAI
models:
  gpt-4o: {}
`,
      'utf-8',
    );

    const registry = await new YamlRegistryFetcher(labsDir, providersDir).fetch();

    expect(registry.updatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

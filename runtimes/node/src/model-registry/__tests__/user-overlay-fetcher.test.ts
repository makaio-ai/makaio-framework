import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IModelRegistryFetcher, ModelRegistry } from '@makaio/services-core/model-registry';
import { UserOverlayFetcher } from '../user-overlay-fetcher.js';

const baseRegistry: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2026-01-30T12:00:00.000Z',
  labs: {
    openai: {
      name: 'OpenAI',
      models: [{ name: 'gpt-4o', friendlyName: 'GPT-4o', contextWindowSize: 128000, labId: 'openai' }],
    },
  },
  providers: {
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-4o': {},
      },
    },
  },
};

async function writeNamelessOpenAiOverlay(tmpDir: string): Promise<void> {
  await fs.mkdir(path.join(tmpDir, 'labs'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'providers'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'labs', 'openai.yaml'),
    `\
models:
  - name: gpt-4o
    friendlyName: GPT-4o Override
    contextWindowSize: 128000
`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmpDir, 'providers', 'openai.yaml'),
    `\
models:
  gpt-4o:
    metadata:
      includedInSubscription: true
`,
    'utf-8',
  );
}

/* eslint max-lines-per-function: ["error", { "max": 700 }] */
describe('UserOverlayFetcher', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'user-overlay-fetcher-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('applies provider-only user YAML over base lab models', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
models:
  gpt-4o:
    metadata:
      includedInSubscription: true
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch();

    expect(registry.labs.openai).toEqual(baseRegistry.labs.openai);
    expect(registry.providers.openai).toEqual({
      name: 'OpenAI Custom',
      models: {
        'gpt-4o': {
          metadata: {
            includedInSubscription: true,
          },
        },
      },
    });
  });

  it('preserves base updatedAt when the user overlay omits updatedAt', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
models:
  gpt-4o:
    metadata:
      includedInSubscription: true
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch();

    expect(registry.updatedAt).toBe(baseRegistry.updatedAt);
  });

  it('preserves base lab and provider names when overlays omit names', async () => {
    await writeNamelessOpenAiOverlay(tmpDir);

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch();

    expect(registry.labs.openai?.name).toBe('OpenAI');
    expect(registry.providers.openai?.name).toBe('OpenAI');
  });

  it('merges provider overlay models without removing base sibling models', async () => {
    const registryWithSiblingModel: ModelRegistry = {
      ...baseRegistry,
      labs: {
        openai: {
          name: 'OpenAI',
          models: [
            { name: 'gpt-4o', friendlyName: 'GPT-4o', contextWindowSize: 128000, labId: 'openai' },
            { name: 'gpt-4o-mini', friendlyName: 'GPT-4o mini', contextWindowSize: 128000, labId: 'openai' },
          ],
        },
      },
      providers: {
        openai: {
          name: 'OpenAI',
          models: {
            'gpt-4o': {
              contextWindowSize: 64000,
              metadata: {
                includedInSubscription: false,
              },
            },
            'gpt-4o-mini': {
              metadata: {
                includedInSubscription: true,
              },
            },
          },
        },
      },
    };

    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
models:
  gpt-4o:
    metadata:
      includedInSubscription: true
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(registryWithSiblingModel)).fetch();

    expect(registry.providers.openai).toEqual({
      name: 'OpenAI Custom',
      models: {
        'gpt-4o': {
          contextWindowSize: 64000,
          metadata: {
            includedInSubscription: true,
          },
        },
        'gpt-4o-mini': {
          metadata: {
            includedInSubscription: true,
          },
        },
      },
    });
  });

  it('merges matching provider model metadata without dropping base metadata fields', async () => {
    const registryWithModelMetadata: ModelRegistry = {
      ...baseRegistry,
      providers: {
        openai: {
          name: 'OpenAI',
          models: {
            'gpt-4o': {
              contextWindowSize: 64000,
              metadata: {
                maxOutputTokens: 8192,
                includedInSubscription: false,
                capabilities: {
                  vision: true,
                  toolCalling: true,
                },
                pricing: {
                  token: {
                    inputPerMillion: 5,
                    outputPerMillion: 15,
                  },
                },
              },
            },
          },
        },
      },
    };

    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
models:
  gpt-4o:
    metadata:
      includedInSubscription: true
      capabilities:
        structuredOutput: true
      pricing:
        request:
          multiplier: 1
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(registryWithModelMetadata)).fetch();

    expect(registry.providers.openai?.models['gpt-4o']?.metadata).toEqual({
      maxOutputTokens: 8192,
      includedInSubscription: true,
      capabilities: {
        structuredOutput: true,
      },
      pricing: {
        request: {
          multiplier: 1,
        },
      },
    });
  });

  it('merges multiple registry-shaped user YAML files touching the same provider and lab', async () => {
    await fs.mkdir(path.join(tmpDir, 'labs'));
    await fs.mkdir(path.join(tmpDir, 'providers'));
    await fs.writeFile(
      path.join(tmpDir, 'labs', 'openai.yaml'),
      `\
name: OpenAI Directory
models:
  - name: gpt-4o
    friendlyName: GPT-4o Directory
    contextWindowSize: 32000
    metadata:
      maxOutputTokens: 4096
      includedInSubscription: false
    labId: openai
  - name: gpt-4.1
    friendlyName: GPT-4.1
    contextWindowSize: 128000
    labId: openai
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'providers', 'openai.yaml'),
      `\
name: OpenAI Provider Directory
models:
  gpt-4o:
    contextWindowSize: 32000
    metadata:
      maxOutputTokens: 4096
      includedInSubscription: false
  gpt-4.1: {}
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, '01-openai.yaml'),
      `\
$schema: makaio/model-registry/v2
labs:
  openai:
    name: OpenAI Overlay A
    models:
      - name: gpt-4o
        friendlyName: GPT-4o Overlay A
        contextWindowSize: 64000
        labId: openai
        metadata:
          maxOutputTokens: 8192
          includedInSubscription: false
          capabilities:
            vision: true
            toolCalling: true
          pricing:
            token:
              inputPerMillion: 5
              outputPerMillion: 15
      - name: gpt-4o-mini
        friendlyName: GPT-4o mini
        contextWindowSize: 128000
        labId: openai
providers:
  openai:
    name: OpenAI Provider A
    models:
      gpt-4o:
        contextWindowSize: 64000
        metadata:
          maxOutputTokens: 8192
          includedInSubscription: false
          capabilities:
            vision: true
            toolCalling: true
          pricing:
            token:
              inputPerMillion: 5
              outputPerMillion: 15
      gpt-4o-mini:
        metadata:
          includedInSubscription: true
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, '02-openai.yaml'),
      `\
$schema: makaio/model-registry/v2
labs:
  openai:
    name: OpenAI Overlay B
    models:
      - name: gpt-4o
        friendlyName: GPT-4o Overlay B
        contextWindowSize: 128000
        labId: openai
        metadata:
          includedInSubscription: true
          capabilities:
            structuredOutput: true
          pricing:
            request:
              multiplier: 1
      - name: gpt-5
        friendlyName: GPT-5
        contextWindowSize: 256000
        labId: openai
providers:
  openai:
    name: OpenAI Provider B
    models:
      gpt-4o:
        metadata:
          includedInSubscription: true
          capabilities:
            structuredOutput: true
          pricing:
            request:
              multiplier: 1
      gpt-5: {}
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch();

    expect(registry.labs.openai).toEqual({
      name: 'OpenAI Overlay B',
      models: [
        {
          name: 'gpt-4o',
          friendlyName: 'GPT-4o Overlay B',
          contextWindowSize: 128000,
          labId: 'openai',
          metadata: {
            maxOutputTokens: 8192,
            includedInSubscription: true,
            capabilities: {
              structuredOutput: true,
            },
            pricing: {
              request: {
                multiplier: 1,
              },
            },
          },
        },
        { name: 'gpt-4.1', friendlyName: 'GPT-4.1', contextWindowSize: 128000, labId: 'openai' },
        { name: 'gpt-4o-mini', friendlyName: 'GPT-4o mini', contextWindowSize: 128000, labId: 'openai' },
        { name: 'gpt-5', friendlyName: 'GPT-5', contextWindowSize: 256000, labId: 'openai' },
      ],
    });
    expect(registry.providers.openai).toEqual({
      name: 'OpenAI Provider B',
      models: {
        'gpt-4o': {
          contextWindowSize: 64000,
          metadata: {
            maxOutputTokens: 8192,
            includedInSubscription: true,
            capabilities: {
              structuredOutput: true,
            },
            pricing: {
              request: {
                multiplier: 1,
              },
            },
          },
        },
        'gpt-4o-mini': {
          metadata: {
            includedInSubscription: true,
          },
        },
        'gpt-4.1': {},
        'gpt-5': {},
      },
    });
  });

  it('merges lab directory and flat lab files touching the same lab', async () => {
    await fs.mkdir(path.join(tmpDir, 'labs'));
    await fs.writeFile(
      path.join(tmpDir, 'labs', 'openai.yaml'),
      `\
name: OpenAI Directory
models:
  - name: gpt-4o
    friendlyName: GPT-4o Directory
    contextWindowSize: 64000
    metadata:
      maxOutputTokens: 8192
      includedInSubscription: false
  - name: gpt-4o-mini
    friendlyName: GPT-4o mini
    contextWindowSize: 128000
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Flat
models:
  - name: gpt-4o
    friendlyName: GPT-4o Flat
    contextWindowSize: 128000
    metadata:
      includedInSubscription: true
      capabilities:
        structuredOutput: true
  - name: gpt-5
    friendlyName: GPT-5
    contextWindowSize: 256000
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch();

    expect(registry.labs.openai).toEqual({
      name: 'OpenAI Flat',
      models: [
        {
          name: 'gpt-4o',
          friendlyName: 'GPT-4o Flat',
          contextWindowSize: 128000,
          labId: 'openai',
          metadata: {
            maxOutputTokens: 8192,
            includedInSubscription: true,
            capabilities: {
              structuredOutput: true,
            },
          },
        },
        { name: 'gpt-4o-mini', friendlyName: 'GPT-4o mini', contextWindowSize: 128000, labId: 'openai' },
        { name: 'gpt-5', friendlyName: 'GPT-5', contextWindowSize: 256000, labId: 'openai' },
      ],
    });
  });

  it('merges provider directory and flat provider files touching the same provider', async () => {
    const registryWithProviderModelLabs: ModelRegistry = {
      ...baseRegistry,
      labs: {
        openai: {
          name: 'OpenAI',
          models: [
            { name: 'gpt-4o', friendlyName: 'GPT-4o', contextWindowSize: 128000, labId: 'openai' },
            { name: 'gpt-4o-mini', friendlyName: 'GPT-4o mini', contextWindowSize: 128000, labId: 'openai' },
            { name: 'gpt-5', friendlyName: 'GPT-5', contextWindowSize: 256000, labId: 'openai' },
          ],
        },
      },
    };

    await fs.mkdir(path.join(tmpDir, 'providers'));
    await fs.writeFile(
      path.join(tmpDir, 'providers', 'openai.yaml'),
      `\
name: OpenAI Directory
models:
  gpt-4o:
    contextWindowSize: 64000
    metadata:
      maxOutputTokens: 8192
      includedInSubscription: false
  gpt-4o-mini:
    metadata:
      includedInSubscription: true
`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Flat
models:
  gpt-4o:
    metadata:
      includedInSubscription: true
      capabilities:
        structuredOutput: true
  gpt-5: {}
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(
      tmpDir,
      new StaticRegistryFetcher(registryWithProviderModelLabs),
    ).fetch();

    expect(registry.providers.openai).toEqual({
      name: 'OpenAI Flat',
      models: {
        'gpt-4o': {
          contextWindowSize: 64000,
          metadata: {
            maxOutputTokens: 8192,
            includedInSubscription: true,
            capabilities: {
              structuredOutput: true,
            },
          },
        },
        'gpt-4o-mini': {
          metadata: {
            includedInSubscription: true,
          },
        },
        'gpt-5': {},
      },
    });
  });

  it('merges lab overlay models without removing base sibling models', async () => {
    const registryWithSiblingLabModel: ModelRegistry = {
      ...baseRegistry,
      labs: {
        openai: {
          name: 'OpenAI',
          models: [
            {
              name: 'gpt-4o',
              friendlyName: 'GPT-4o',
              contextWindowSize: 128000,
              labId: 'openai',
              metadata: {
                maxOutputTokens: 8192,
                includedInSubscription: false,
                capabilities: {
                  vision: true,
                  toolCalling: true,
                },
                pricing: {
                  token: {
                    inputPerMillion: 5,
                    outputPerMillion: 15,
                  },
                },
              },
            },
            { name: 'gpt-4o-mini', friendlyName: 'GPT-4o mini', contextWindowSize: 128000, labId: 'openai' },
          ],
        },
      },
    };

    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
models:
  - name: gpt-4o
    friendlyName: GPT-4o Custom
    contextWindowSize: 64000
    metadata:
      includedInSubscription: true
      capabilities:
        structuredOutput: true
      pricing:
        request:
          multiplier: 1
  - name: gpt-5
    friendlyName: GPT-5
    contextWindowSize: 256000
`,
      'utf-8',
    );

    const registry = await new UserOverlayFetcher(
      tmpDir,
      new StaticRegistryFetcher(registryWithSiblingLabModel),
    ).fetch();

    expect(registry.labs.openai).toEqual({
      name: 'OpenAI Custom',
      models: [
        {
          name: 'gpt-4o',
          friendlyName: 'GPT-4o Custom',
          contextWindowSize: 64000,
          labId: 'openai',
          metadata: {
            maxOutputTokens: 8192,
            includedInSubscription: true,
            capabilities: {
              structuredOutput: true,
            },
            pricing: {
              request: {
                multiplier: 1,
              },
            },
          },
        },
        { name: 'gpt-4o-mini', friendlyName: 'GPT-4o mini', contextWindowSize: 128000, labId: 'openai' },
        { name: 'gpt-5', friendlyName: 'GPT-5', contextWindowSize: 256000, labId: 'openai' },
      ],
    });
  });

  it('rejects provider-only user YAML that references an unknown merged model', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
models:
  missing-model: {}
`,
      'utf-8',
    );

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /missing-model/,
    );
  });

  it('does not use an absent user overlay as a fallback when the base registry fails', async () => {
    const baseError = new Error('base registry unavailable');

    await expect(new UserOverlayFetcher(tmpDir, new FailingRegistryFetcher(baseError)).fetch()).rejects.toThrow(
      baseError,
    );
  });

  it('returns the base registry when the user overlay directory is empty', async () => {
    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).resolves.toBe(
      baseRegistry,
    );
  });

  it('returns the base registry when the user overlay directory is missing', async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).resolves.toBe(
      baseRegistry,
    );
  });

  it('rejects a user overlay root path that is a file', async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.writeFile(tmpDir, 'not a directory', 'utf-8');

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /Invalid model registry directory/,
    );
  });

  it('rejects user overlay labs and providers paths that are files', async () => {
    await fs.writeFile(path.join(tmpDir, 'labs'), 'not a directory', 'utf-8');

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /Invalid model registry directory/,
    );

    await fs.rm(path.join(tmpDir, 'labs'), { force: true });
    await fs.writeFile(path.join(tmpDir, 'providers'), 'not a directory', 'utf-8');

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /Invalid model registry directory/,
    );
  });

  it('rejects non-object user overlay YAML instead of returning the base registry', async () => {
    await fs.writeFile(path.join(tmpDir, 'openai.yaml'), 'invalid', 'utf-8');

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /Invalid model registry overlay YAML.*openai\.yaml/,
    );
  });

  it('rejects user overlay YAML with no recognizable registry shape', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
model:
  gpt-4o: {}
`,
      'utf-8',
    );

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /Unrecognized model registry overlay shape.*openai\.yaml/,
    );
  });

  it('rejects invalid user overlay schema instead of returning the base registry', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'openai.yaml'),
      `\
name: OpenAI Custom
models:
  gpt-4o:
    contextWindowSize: invalid
`,
      'utf-8',
    );

    await expect(new UserOverlayFetcher(tmpDir, new StaticRegistryFetcher(baseRegistry)).fetch()).rejects.toThrow(
      /contextWindowSize/,
    );
  });
});

class StaticRegistryFetcher implements IModelRegistryFetcher {
  public constructor(private readonly registry: ModelRegistry) {}

  public async fetch(): Promise<ModelRegistry> {
    return this.registry;
  }
}

class FailingRegistryFetcher implements IModelRegistryFetcher {
  public constructor(private readonly error: Error) {}

  public async fetch(): Promise<ModelRegistry> {
    throw this.error;
  }
}

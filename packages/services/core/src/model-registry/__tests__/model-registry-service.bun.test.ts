import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ModelRegistryPublicSubjects } from '@makaio/contracts/model-registry';
import { ModelRegistryService } from '../model-registry-service.js';
import { ModelRegistrySubjects } from '../namespace.js';
import { ModelRegistrySchema, type ModelRegistry } from '../schemas.js';
import type { IModelRegistryFetcher } from '../types.js';

/**
 * Mock v2 registry data for testing.
 *
 * Lab `anthropic` owns two models; provider `anthropic` serves both with
 * metadata overrides, and provider `openrouter` serves them without overrides.
 */
const mockRegistry: ModelRegistry = {
  $schema: 'makaio/model-registry/v2',
  updatedAt: '2026-01-30T12:00:00Z',
  labs: {
    anthropic: {
      name: 'Anthropic',
      models: [
        {
          name: 'claude-sonnet-4-6',
          friendlyName: 'Claude Sonnet 4.6',
          contextWindowSize: 200_000,
          labId: 'anthropic',
          metadata: {
            maxOutputTokens: 8_192,
            capabilities: {
              vision: true,
              toolCalling: false,
            },
            pricing: {
              token: {
                inputPerMillion: 2.5,
                outputPerMillion: 12.5,
              },
            },
          },
        },
        {
          name: 'claude-haiku-4-5',
          friendlyName: 'Claude Haiku 4.5',
          contextWindowSize: 200_000,
          labId: 'anthropic',
        },
      ],
    },
    openai: {
      name: 'OpenAI',
      models: [
        {
          name: 'gpt-4o',
          friendlyName: 'GPT-4o',
          contextWindowSize: 128_000,
          labId: 'openai',
        },
      ],
    },
  },
  providers: {
    anthropic: {
      name: 'Anthropic',
      models: {
        'claude-sonnet-4-6': {
          metadata: {
            includedInSubscription: true,
            capabilities: {
              toolCalling: true,
            },
            pricing: {
              request: { multiplier: 1 },
            },
          },
        },
        'claude-haiku-4-5': {},
      },
    },
    openrouter: {
      name: 'OpenRouter',
      models: {
        'claude-sonnet-4-6': {},
        'gpt-4o': {},
      },
    },
  },
};

const registryWithUnknownProviderModel: ModelRegistry = {
  ...mockRegistry,
  providers: {
    anthropic: {
      name: 'Anthropic',
      models: {
        'claude-opus-missing': {},
      },
    },
  },
};

const registryWithDuplicateLabModelName: ModelRegistry = {
  ...mockRegistry,
  labs: {
    ...mockRegistry.labs,
    openai: {
      name: 'OpenAI',
      models: [
        {
          name: 'gpt-4o',
          friendlyName: 'GPT-4o',
          contextWindowSize: 128_000,
          labId: 'openai',
        },
        {
          name: 'claude-sonnet-4-6',
          friendlyName: 'Duplicate Claude Sonnet 4.6',
          contextWindowSize: 128_000,
          labId: 'openai',
        },
      ],
    },
  },
};

const registryWithMismatchedLabId: ModelRegistry = {
  ...mockRegistry,
  labs: {
    ...mockRegistry.labs,
    anthropic: {
      name: 'Anthropic',
      models: [
        {
          name: 'claude-sonnet-4-6',
          friendlyName: 'Claude Sonnet 4.6',
          contextWindowSize: 200_000,
          labId: 'openai',
          metadata: {
            capabilities: {
              vision: true,
              toolCalling: false,
            },
            pricing: {
              token: {
                inputPerMillion: 2.5,
                outputPerMillion: 12.5,
              },
            },
          },
        },
        {
          name: 'claude-haiku-4-5',
          friendlyName: 'Claude Haiku 4.5',
          contextWindowSize: 200_000,
          labId: 'anthropic',
        },
      ],
    },
  },
};

const registryWithProviderIdentityOverride = {
  ...mockRegistry,
  providers: {
    anthropic: {
      name: 'Anthropic',
      models: {
        'claude-sonnet-4-6': {
          name: 'renamed-sonnet',
          labId: 'other-lab',
        },
      },
    },
  },
};

const registryWithProviderNativeModelId: ModelRegistry = {
  ...mockRegistry,
  providers: {
    openrouter: {
      name: 'OpenRouter',
      models: {
        'anthropic/claude-sonnet-4-6': {
          canonicalModel: 'claude-sonnet-4-6',
          metadata: {
            includedInSubscription: true,
          },
        },
      },
    },
  },
};

interface Deferred<T> {
  /** Promise controlled by this deferred handle. */
  promise: Promise<T>;
  /** Resolve the controlled promise. */
  resolve: (value: T) => void;
  /** Reject the controlled promise. */
  reject: (error: Error) => void;
}

/**
 * Create a promise controlled by the returned resolve/reject callbacks.
 * @returns Deferred promise handle
 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Mock fetcher that can simulate success, failure, or delay.
 *
 * Implements the {@link IModelRegistryFetcher} contract faithfully: queued data
 * is validated via {@link ModelRegistrySchema.parse} before being returned, just
 * as every real fetcher implementation must do.
 */
class MockRegistryFetcher implements IModelRegistryFetcher {
  public fetchCount = 0;
  private shouldFail = false;
  private delayMs = 0;
  private queuedFetches: Array<Promise<unknown>> = [];

  public async fetch(): Promise<ModelRegistry> {
    this.fetchCount++;
    const queuedFetch = this.queuedFetches.shift();
    if (queuedFetch) {
      const raw = await queuedFetch;
      return ModelRegistrySchema.parse(raw);
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.shouldFail) {
      throw new Error('Mock fetch failed');
    }
    return ModelRegistrySchema.parse(mockRegistry);
  }

  public setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  public setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /**
   * Queue an externally-controlled fetch result for the next fetch call.
   *
   * The queued value is treated as raw (unvalidated) data — exactly as a real
   * fetcher would receive from its source — and schema-validated inside `fetch()`.
   * Pass a valid {@link ModelRegistry} for happy-path tests, or an intentionally
   * invalid object to simulate fetcher validation failures.
   * @param promise - Promise of raw data resolved by the next fetch call
   */
  public enqueueFetch(promise: Promise<unknown>): void {
    this.queuedFetches.push(promise);
  }

  public reset(): void {
    this.fetchCount = 0;
    this.shouldFail = false;
    this.delayMs = 0;
    this.queuedFetches = [];
  }
}

/**
 * Track model-registry change events for a single test.
 * @returns Counter accessor and cleanup callback.
 */
function trackChangedEvents(): { count: () => number; cleanup: () => void } {
  let changedCount = 0;
  const cleanup = MakaioBus.on(ModelRegistrySubjects.changed, () => {
    changedCount += 1;
  });

  return {
    count: () => changedCount,
    cleanup,
  };
}

describe('ModelRegistryService', () => {
  let service: ModelRegistryService;
  let fetcher: MockRegistryFetcher;

  beforeEach(async () => {
    fetcher = new MockRegistryFetcher();
    service = new ModelRegistryService({
      bus: MakaioBus,
      fetcher,
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    fetcher.reset();
  });

  describe('modelRegistry.getForProvider', () => {
    it('returns merged model for a known provider and model', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(result.model).toBeDefined();
      expect(result.model?.name).toBe('claude-sonnet-4-6');
      expect(result.model?.labId).toBe('anthropic');
      expect(result.model?.metadata?.pricing?.request?.multiplier).toBe(1);
      expect(fetcher.fetchCount).toBe(1);
    });

    it('returns model without overrides when provider entry is empty', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      });

      expect(result.model).toBeDefined();
      expect(result.model?.name).toBe('claude-haiku-4-5');
      expect(result.model?.metadata?.pricing).toBeUndefined();
    });

    it('returns undefined for unknown provider', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'unknown-provider',
        model: 'claude-sonnet-4-6',
      });

      expect(result.model).toBeUndefined();
    });

    it('returns undefined for model not offered by the provider', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'gpt-4o',
      });

      expect(result.model).toBeUndefined();
    });

    it('uses in-memory cache after first fetch', async () => {
      await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
      expect(fetcher.fetchCount).toBe(1);

      await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      });
      expect(fetcher.fetchCount).toBe(1);
    });

    it('handles concurrent requests efficiently', async () => {
      const requests = Array.from({ length: 5 }, () =>
        MakaioBus.request(ModelRegistrySubjects.getForProvider, {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-6',
        }),
      );

      const results = await Promise.all(requests);

      results.forEach((result) => {
        expect(result.model).toBeDefined();
      });
      expect(fetcher.fetchCount).toBe(1);
    });

    it('throws when fetcher fails', async () => {
      fetcher.setShouldFail(true);

      await expect(
        MakaioBus.request(ModelRegistrySubjects.getForProvider, {
          providerId: 'anthropic',
          model: 'claude-sonnet-4-6',
        }),
      ).rejects.toThrow(/Mock fetch failed/);
    });
  });

  describe('modelRegistry.getLabModels', () => {
    it('returns canonical models for a known lab', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'anthropic',
      });

      expect(result.models).toHaveLength(2);
      expect(result.models[0].name).toBe('claude-sonnet-4-6');
      expect(result.models[1].name).toBe('claude-haiku-4-5');
    });

    it('returns cloned lab models so callers cannot mutate the cache', async () => {
      const firstResult = await MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'anthropic',
      });

      firstResult.models.push({
        name: 'mutated-model',
        friendlyName: 'Mutated Model',
        contextWindowSize: 1,
        labId: 'anthropic',
      });
      firstResult.models[0].friendlyName = 'Mutated Claude';
      firstResult.models[0].metadata!.capabilities!.vision = false;

      const secondResult = await MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'anthropic',
      });

      expect(secondResult.models).toHaveLength(2);
      expect(secondResult.models[0].friendlyName).toBe('Claude Sonnet 4.6');
      expect(secondResult.models[0].metadata?.capabilities?.vision).toBe(true);
    });

    it('returns empty array for unknown lab', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'unknown-lab',
      });

      expect(result.models).toEqual([]);
    });

    it('throws when fetcher fails', async () => {
      fetcher.setShouldFail(true);

      await expect(MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' })).rejects.toThrow(
        /Mock fetch failed/,
      );
    });
  });

  describe('modelRegistry.getProviderModels', () => {
    it('returns all merged models for a known provider', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
        providerId: 'anthropic',
      });

      expect(result.models).toHaveLength(2);
      const sonnet = result.models.find((m) => m.name === 'claude-sonnet-4-6');
      expect(sonnet?.metadata?.pricing?.request?.multiplier).toBe(1);
    });

    it('returns cloned provider models so callers cannot mutate merged results', async () => {
      const firstResult = await MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
        providerId: 'anthropic',
      });
      const sonnet = firstResult.models.find((m) => m.name === 'claude-sonnet-4-6');
      expect(sonnet).toBeDefined();

      firstResult.models.push({
        name: 'mutated-model',
        friendlyName: 'Mutated Model',
        contextWindowSize: 1,
        labId: 'anthropic',
      });
      sonnet!.friendlyName = 'Mutated Sonnet';
      sonnet!.metadata!.pricing!.request!.multiplier = 99;
      sonnet!.metadata!.capabilities!.toolCalling = false;

      const secondResult = await MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
        providerId: 'anthropic',
      });
      const secondSonnet = secondResult.models.find((m) => m.name === 'claude-sonnet-4-6');

      expect(secondResult.models).toHaveLength(2);
      expect(secondSonnet?.friendlyName).toBe('Claude Sonnet 4.6');
      expect(secondSonnet?.metadata?.pricing?.request?.multiplier).toBe(1);
      expect(secondSonnet?.metadata?.capabilities?.toolCalling).toBe(true);
    });

    it('returns models from multiple labs for an aggregating provider', async () => {
      // openrouter serves claude-sonnet-4-6 (anthropic lab) and gpt-4o (openai lab)
      const result = await MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
        providerId: 'openrouter',
      });

      expect(result.models).toHaveLength(2);
      const names = result.models.map((m) => m.name).sort();
      expect(names).toEqual(['claude-sonnet-4-6', 'gpt-4o']);
    });

    it('throws for unknown provider', async () => {
      await expect(
        MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
          providerId: 'unknown-provider',
        }),
      ).rejects.toThrow(/Provider "unknown-provider" is not present in the model registry/);
    });

    it('throws when fetcher fails', async () => {
      fetcher.setShouldFail(true);

      await expect(
        MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
          providerId: 'anthropic',
        }),
      ).rejects.toThrow(/Mock fetch failed/);
    });
  });

  describe('modelRegistry:public.supportedModels', () => {
    it('returns SDK-safe model descriptors across providers', async () => {
      const result = await MakaioBus.request(ModelRegistryPublicSubjects.supportedModels, {});

      expect(result.models).toEqual([
        {
          name: 'claude-haiku-4-5',
          friendlyName: 'Claude Haiku 4.5',
          contextWindowSize: 200_000,
          provider: 'anthropic',
        },
        {
          name: 'claude-sonnet-4-6',
          friendlyName: 'Claude Sonnet 4.6',
          contextWindowSize: 200_000,
          provider: 'anthropic',
        },
        {
          name: 'claude-sonnet-4-6',
          friendlyName: 'Claude Sonnet 4.6',
          contextWindowSize: 200_000,
          provider: 'openrouter',
        },
        {
          name: 'gpt-4o',
          friendlyName: 'GPT-4o',
          contextWindowSize: 128_000,
          provider: 'openrouter',
        },
      ]);
      expect(fetcher.fetchCount).toBe(1);
    });
  });

  describe('modelRegistry.refresh', () => {
    it('force refreshes from fetcher chain', async () => {
      await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });
      expect(fetcher.fetchCount).toBe(1);

      const result = await MakaioBus.request(ModelRegistrySubjects.refresh, {});

      expect(result.success).toBe(true);
      expect(fetcher.fetchCount).toBe(2);
    });

    it('emits changed after a successful refresh commit', async () => {
      const changed = trackChangedEvents();

      try {
        const result = await MakaioBus.request(ModelRegistrySubjects.refresh, {});

        expect(result.success).toBe(true);
        expect(fetcher.fetchCount).toBe(1);
        expect(changed.count()).toBe(1);
      } finally {
        changed.cleanup();
      }
    });

    it('returns error when refresh fails', async () => {
      fetcher.setShouldFail(true);

      const result = await MakaioBus.request(ModelRegistrySubjects.refresh, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Mock fetch failed');
    });

    it('does not emit changed when refresh fails', async () => {
      const changed = trackChangedEvents();
      fetcher.setShouldFail(true);

      try {
        const result = await MakaioBus.request(ModelRegistrySubjects.refresh, {});

        expect(result.success).toBe(false);
        expect(changed.count()).toBe(0);
      } finally {
        changed.cleanup();
      }
    });

    it('shares one active refresh between concurrent refresh callers', async () => {
      const changed = trackChangedEvents();
      const pendingFetch = createDeferred<ModelRegistry>();
      fetcher.enqueueFetch(pendingFetch.promise);

      try {
        const firstRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
        await Promise.resolve();

        const secondRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
        await Promise.resolve();

        expect(fetcher.fetchCount).toBe(1);

        pendingFetch.resolve(mockRegistry);
        const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);

        expect(firstResult.success).toBe(true);
        expect(secondResult.success).toBe(true);
        expect(changed.count()).toBe(1);
        expect(fetcher.fetchCount).toBe(1);
      } finally {
        changed.cleanup();
      }
    });

    it('shares an in-flight refresh fetch when another caller overlaps after failure mode is set', async () => {
      const pendingFetch = createDeferred<ModelRegistry>();
      fetcher.enqueueFetch(pendingFetch.promise);

      const firstRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
      await Promise.resolve();

      fetcher.setShouldFail(true);
      const secondRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
      await Promise.resolve();

      pendingFetch.resolve(mockRegistry);
      const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);

      const getResult = await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });
      expect(getResult.models).toHaveLength(2);
      expect(fetcher.fetchCount).toBe(1);
    });

    it('rejects a registry whose provider references an unknown lab model', async () => {
      const changed = trackChangedEvents();
      fetcher.enqueueFetch(Promise.resolve(registryWithUnknownProviderModel));

      try {
        const result = await MakaioBus.request(ModelRegistrySubjects.refresh, {});

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown provider model reference');
        expect(changed.count()).toBe(0);
      } finally {
        changed.cleanup();
      }
    });

    it('surfaces registry unavailability after failed refresh clears the cache', async () => {
      await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });

      fetcher.setShouldFail(true);
      const refreshResult = await MakaioBus.request(ModelRegistrySubjects.refresh, {});
      expect(refreshResult.success).toBe(false);

      await expect(MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' })).rejects.toThrow(
        /Mock fetch failed/,
      );
    });

    it('shares the refresh fetch with concurrent gets and emits one change event', async () => {
      const changed = trackChangedEvents();
      await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });
      const refreshFetch = createDeferred<ModelRegistry>();
      const refreshedRegistry: ModelRegistry = {
        ...mockRegistry,
        labs: {
          ...mockRegistry.labs,
          anthropic: {
            name: 'Anthropic',
            models: [
              {
                name: 'claude-sonnet-4-7',
                friendlyName: 'Claude Sonnet 4.7',
                contextWindowSize: 300_000,
                labId: 'anthropic',
              },
            ],
          },
        },
        providers: {
          anthropic: {
            name: 'Anthropic',
            models: { 'claude-sonnet-4-7': {} },
          },
          openrouter: {
            name: 'OpenRouter',
            models: { 'gpt-4o': {} },
          },
        },
      };
      fetcher.enqueueFetch(refreshFetch.promise);

      try {
        const pendingRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
        await Promise.resolve();

        const pendingGet = MakaioBus.request(ModelRegistrySubjects.getLabModels, {
          labId: 'anthropic',
        });
        await Promise.resolve();
        expect(fetcher.fetchCount).toBe(2);

        refreshFetch.resolve(refreshedRegistry);
        const [refreshResult, getResult] = await Promise.all([pendingRefresh, pendingGet]);

        expect(refreshResult.success).toBe(true);
        expect(getResult.models).toHaveLength(1);
        expect(getResult.models[0].name).toBe('claude-sonnet-4-7');
        expect(changed.count()).toBe(1);
        expect(fetcher.fetchCount).toBe(2);
      } finally {
        changed.cleanup();
      }
    });

    it('does not report success or emit changed for a stale in-flight refresh after destroy', async () => {
      const changed = trackChangedEvents();
      const pendingFetch = createDeferred<ModelRegistry>();
      fetcher.enqueueFetch(pendingFetch.promise);

      try {
        const pendingRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
        await Promise.resolve();
        await service.destroy();
        pendingFetch.resolve(mockRegistry);

        const result = await pendingRefresh;

        expect(result.success).toBe(false);
        expect(result.error).toBe('Model registry refresh completed without committing a registry');
        expect(changed.count()).toBe(0);
      } finally {
        changed.cleanup();
      }
    });

    it('shares an in-flight get fetch with refresh instead of starting a competing fetch', async () => {
      const changed = trackChangedEvents();
      const pendingFetch = createDeferred<ModelRegistry>();
      fetcher.enqueueFetch(pendingFetch.promise);

      try {
        const pendingGet = MakaioBus.request(ModelRegistrySubjects.getLabModels, {
          labId: 'anthropic',
        });
        await Promise.resolve();

        const pendingRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
        await Promise.resolve();

        expect(fetcher.fetchCount).toBe(1);

        pendingFetch.resolve(mockRegistry);
        const [getResult, refreshResult] = await Promise.all([pendingGet, pendingRefresh]);

        expect(getResult.models).toHaveLength(2);
        expect(refreshResult.success).toBe(true);
        expect(changed.count()).toBe(1);
        expect(fetcher.fetchCount).toBe(1);
      } finally {
        changed.cleanup();
      }
    });

    it('does not report refresh success when a shared get fetch is invalidated before commit', async () => {
      const changed = trackChangedEvents();
      const pendingFetch = createDeferred<ModelRegistry>();
      fetcher.enqueueFetch(pendingFetch.promise);

      try {
        const pendingGet = MakaioBus.request(ModelRegistrySubjects.getLabModels, {
          labId: 'anthropic',
        });
        await Promise.resolve();

        const pendingRefresh = MakaioBus.request(ModelRegistrySubjects.refresh, {});
        await Promise.resolve();

        await service.destroy();
        pendingFetch.resolve(mockRegistry);
        const [getResult, refreshResult] = await Promise.all([pendingGet, pendingRefresh]);

        expect(getResult.models).toHaveLength(2);
        expect(refreshResult.success).toBe(false);
        expect(refreshResult.error).toBe('Model registry refresh completed without committing a registry');
        expect(changed.count()).toBe(0);
        expect(fetcher.fetchCount).toBe(1);
      } finally {
        changed.cleanup();
      }
    });
  });

  describe('modelRegistry.checkModelInProviders', () => {
    it('returns merged models for all providers that have the model', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['anthropic', 'openrouter'],
        model: 'claude-sonnet-4-6',
      });

      expect(Object.keys(result.matches)).toHaveLength(2);
      expect(result.matches['anthropic']).toBeDefined();
      expect(result.matches['anthropic'].name).toBe('claude-sonnet-4-6');
      expect(result.matches['openrouter']).toBeDefined();
      expect(result.matches['openrouter'].name).toBe('claude-sonnet-4-6');
    });

    it('omits providers that do not have the model', async () => {
      // anthropic does not offer gpt-4o; openrouter does
      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['anthropic', 'openrouter'],
        model: 'gpt-4o',
      });

      expect(result.matches['anthropic']).toBeUndefined();
      expect(result.matches['openrouter']).toBeDefined();
      expect(result.matches['openrouter'].name).toBe('gpt-4o');
    });

    it('omits unknown provider IDs from the result', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['anthropic', 'unknown-provider', 'also-missing'],
        model: 'claude-sonnet-4-6',
      });

      expect(Object.keys(result.matches)).toHaveLength(1);
      expect(result.matches['anthropic']).toBeDefined();
      expect(result.matches['unknown-provider']).toBeUndefined();
    });

    it('returns empty matches for an empty providerIds array', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: [],
        model: 'claude-sonnet-4-6',
      });

      expect(result.matches).toEqual({});
    });

    it('returns empty matches when no provider has the model', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['anthropic', 'openrouter'],
        model: 'nonexistent-model',
      });

      expect(result.matches).toEqual({});
    });

    it('applies provider overrides to matched models', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['anthropic'],
        model: 'claude-sonnet-4-6',
      });

      // anthropic provider overrides pricing.request for claude-sonnet-4-6
      expect(result.matches['anthropic']?.metadata?.pricing?.request?.multiplier).toBe(1);
      // anthropic provider overrides capabilities.toolCalling to true
      expect(result.matches['anthropic']?.metadata?.capabilities?.toolCalling).toBe(true);
    });

    it('uses in-memory cache after first fetch', async () => {
      await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['anthropic'],
        model: 'claude-sonnet-4-6',
      });
      expect(fetcher.fetchCount).toBe(1);

      await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['openrouter'],
        model: 'gpt-4o',
      });
      expect(fetcher.fetchCount).toBe(1);
    });

    it('matches provider-native model IDs by canonical model reference', async () => {
      fetcher.enqueueFetch(Promise.resolve(registryWithProviderNativeModelId));

      const result = await MakaioBus.request(ModelRegistrySubjects.checkModelInProviders, {
        providerIds: ['openrouter'],
        model: 'claude-sonnet-4-6',
      });

      expect(result.matches['openrouter']?.name).toBe('anthropic/claude-sonnet-4-6');
      expect(result.matches['openrouter']?.labId).toBe('anthropic');
      expect(result.matches['openrouter']?.metadata?.includedInSubscription).toBe(true);
    });
  });

  describe('service lifecycle', () => {
    it('is idempotent on init', async () => {
      await service.init();
      await service.init();
      await service.init();

      const result = await MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'anthropic',
      });
      expect(result.models.length).toBeGreaterThan(0);
    });

    it('is idempotent on destroy', async () => {
      await service.destroy();
      await service.destroy();
      await service.destroy();

      expect(true).toBe(true);
    });

    it('clears in-memory cache on destroy', async () => {
      await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });
      expect(fetcher.fetchCount).toBe(1);

      await service.destroy();
      await service.init();

      await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });
      expect(fetcher.fetchCount).toBe(2);
    });

    it('does not repopulate cache from stale in-flight fetch after destroy', async () => {
      const pendingFetch = createDeferred<ModelRegistry>();
      fetcher.enqueueFetch(pendingFetch.promise);

      const pendingGet = MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'anthropic',
      });
      await Promise.resolve();
      await service.destroy();
      pendingFetch.resolve(mockRegistry);

      const firstResult = await pendingGet;
      expect(firstResult.models).toBeDefined();
      expect(fetcher.fetchCount).toBe(1);

      await service.init();
      await MakaioBus.request(ModelRegistrySubjects.getLabModels, { labId: 'anthropic' });

      expect(fetcher.fetchCount).toBe(2);
    });
  });

  describe('merge logic', () => {
    it('applies provider pricing overrides to lab model', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(result.model?.metadata?.pricing).toEqual({
        request: { multiplier: 1 },
      });
    });

    it('preserves lab model fields not overridden by provider', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(result.model?.friendlyName).toBe('Claude Sonnet 4.6');
      expect(result.model?.contextWindowSize).toBe(200_000);
    });

    it('replaces provider metadata blocks instead of mixing lab and provider fields', async () => {
      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(result.model?.metadata?.capabilities).toEqual({
        toolCalling: true,
      });
      expect(result.model?.metadata?.pricing).toEqual({
        request: { multiplier: 1 },
      });
      expect(result.model?.metadata?.maxOutputTokens).toBe(8_192);
      expect(result.model?.metadata?.includedInSubscription).toBe(true);
    });

    it('returns an equivalent lab model when provider overrides are empty', async () => {
      const labResult = await MakaioBus.request(ModelRegistrySubjects.getLabModels, {
        labId: 'anthropic',
      });
      const labModel = labResult.models.find((m) => m.name === 'claude-haiku-4-5');

      const providerResult = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      });

      expect(providerResult.model).toEqual(labModel);
    });

    it('returns cloned models when provider overrides are empty', async () => {
      const firstResult = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      });

      expect(firstResult.model).toBeDefined();
      firstResult.model!.friendlyName = 'Mutated Haiku';

      const secondResult = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'anthropic',
        model: 'claude-haiku-4-5',
      });

      expect(secondResult.model?.friendlyName).toBe('Claude Haiku 4.5');
    });

    it('resolves provider-native model IDs through canonical model references', async () => {
      fetcher.enqueueFetch(Promise.resolve(registryWithProviderNativeModelId));

      const result = await MakaioBus.request(ModelRegistrySubjects.getForProvider, {
        providerId: 'openrouter',
        model: 'anthropic/claude-sonnet-4-6',
      });

      expect(result.model).toMatchObject({
        name: 'anthropic/claude-sonnet-4-6',
        friendlyName: 'Claude Sonnet 4.6',
        contextWindowSize: 200_000,
        labId: 'anthropic',
      });
      expect(result.model?.metadata?.includedInSubscription).toBe(true);
    });

    it('lists provider-native model IDs when a provider aliases a canonical model', async () => {
      fetcher.enqueueFetch(Promise.resolve(registryWithProviderNativeModelId));

      const result = await MakaioBus.request(ModelRegistrySubjects.getProviderModels, {
        providerId: 'openrouter',
      });

      expect(result.models).toMatchObject([
        {
          name: 'anthropic/claude-sonnet-4-6',
          labId: 'anthropic',
        },
      ]);
    });
  });

  describe('schema validation', () => {
    it('accepts provider-native model IDs with canonical model references', () => {
      const result = ModelRegistrySchema.safeParse(registryWithProviderNativeModelId);

      expect(result.success).toBe(true);
    });

    it('rejects provider model names that do not exist in any lab', () => {
      const result = ModelRegistrySchema.safeParse(registryWithUnknownProviderModel);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Unknown provider model reference');
    });

    it('rejects canonical model references that do not exist in any lab', () => {
      const result = ModelRegistrySchema.safeParse({
        ...mockRegistry,
        providers: {
          openrouter: {
            name: 'OpenRouter',
            models: {
              'anthropic/claude-missing': {
                canonicalModel: 'claude-missing',
              },
            },
          },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Unknown provider model reference');
    });

    it('rejects duplicate canonical model references within a provider', () => {
      const result = ModelRegistrySchema.safeParse({
        ...mockRegistry,
        providers: {
          openrouter: {
            name: 'OpenRouter',
            models: {
              'anthropic/claude-sonnet-4-6': {
                canonicalModel: 'claude-sonnet-4-6',
              },
              'anthropic/claude-sonnet-4-6:beta': {
                canonicalModel: 'claude-sonnet-4-6',
              },
            },
          },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Duplicate canonical model reference');
    });

    it('rejects duplicate canonical model names across labs', () => {
      const result = ModelRegistrySchema.safeParse(registryWithDuplicateLabModelName);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Duplicate canonical model name');
    });

    it('rejects lab models whose labId does not match the lab key', () => {
      const result = ModelRegistrySchema.safeParse(registryWithMismatchedLabId);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('does not match lab key');
    });

    it('rejects provider overrides for model identity fields', () => {
      const result = ModelRegistrySchema.safeParse(registryWithProviderIdentityOverride);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Provider model overrides cannot include identity fields');
    });
  });
});

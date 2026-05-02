# @makaio/services-core/model-registry

Model registry service for discovering and caching AI model configurations.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  ModelRegistryService                        │
│  In-memory cache + concurrent request deduplication         │
│  Bus handlers for query/refresh subjects                    │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│               IModelRegistryFetcher (chain)                  │
│  FallbackRegistryFetcher → tries sources in order           │
│    └─ CachedRegistryFetcher (inner fetcher + cache)         │
└─────────────────────────────────────────────────────────────┘
```

## Registry Format (v2)

The registry uses a two-tier lab/provider structure (`makaio/model-registry/v2`):

- **Labs** define canonical model metadata (name, context window, reasoning levels, etc.)
- **Providers** declare which model IDs they serve, optionally point provider-native IDs at canonical lab models, and supply provider-specific overrides (pricing, capabilities)

At query time the service merges provider overrides onto the lab definition to produce a `ProviderAIModel`. The returned
model `name` is the provider-native ID that callers send to that provider API.

## Components

### ModelRegistryService

`model-registry-service.ts`

Extends `BaseService`. Holds one in-memory `ModelRegistry`, shares concurrent loads through `fetchPromise`, and
registers bus handlers. `fetchGeneration` is a stale-commit guard: destroy/refresh bumps the generation so older
in-flight fetches cannot repopulate the cache or report a successful committed refresh.

### Fetcher Implementations

| Class | Purpose |
|-------|---------|
| `FallbackRegistryFetcher` | Tries fetchers in order, returns first success |
| `CachedRegistryFetcher` | Wraps an inner fetcher with persistent cache; on failure returns stale cached data |

### Interfaces

| Interface | Purpose |
|-----------|---------|
| `IModelRegistryFetcher` | Single method `fetch(): Promise<ModelRegistry>` — plug in new registry sources |
| `IModelRegistryCache` | `get()` / `set()` — swap cache backends (file, localStorage, in-memory) |

### Utilities

| Export | Purpose |
|--------|---------|
| `mergeModelMetadata` | Merge lab + provider metadata with block-level replacement for capabilities/pricing |

## Bus Subjects

Namespace prefix: `modelRegistry.`

| Subject | Direction | Description |
|---------|-----------|-------------|
| `getForProvider` | request/response | Resolve a single model by provider + provider-native model ID |
| `getLabModels` | request/response | List all canonical models for a lab |
| `getProviderModels` | request/response | List all merged models available from a provider |
| `checkModelInProviders` | request/response | Batch-check a canonical lab model across multiple providers in one RPC |
| `refresh` | request/response | Force re-fetch from the fetcher chain |
| `changed` | event (fire-and-forget) | Emitted after a successful refresh commits |

Concurrent callers share the active `fetchPromise`; concurrent refresh callers also share `refreshPromise`. A refresh
that joins an active fetch only succeeds if that fetch commits for the current generation.

## Usage

```typescript
import {
  ModelRegistryService,
  FallbackRegistryFetcher,
  CachedRegistryFetcher,
  ModelRegistrySubjects,
} from '@makaio/services-core/model-registry';

const service = new ModelRegistryService({
  bus,
  fetcher: new FallbackRegistryFetcher([
    new CachedRegistryFetcher(cdnFetcher, fileCache),
    bundledSeedFetcher,
  ]),
});
await service.init();

// Query models for a provider
const { models } = await bus.request(ModelRegistrySubjects.getProviderModels, {
  providerId: 'anthropic',
});

// Resolve a single model
const { model: resolved } = await bus.request(ModelRegistrySubjects.getForProvider, {
  providerId: 'openrouter',
  model: 'anthropic/claude-sonnet-4-6',
});

// `getForProvider` returns the resolved provider model on the `model` field.

// Batch-check across providers
const { matches } = await bus.request(ModelRegistrySubjects.checkModelInProviders, {
  providerIds: ['anthropic', 'openrouter', 'z-ai'],
  model: 'claude-sonnet-4-6',
});

// Force refresh
await bus.request(ModelRegistrySubjects.refresh, {});

// Observe registry changes
bus.on(ModelRegistrySubjects.changed, () => {
  // Rescan dependent providers
});
```

## SEAMS (Extension Points)

- **`IModelRegistryFetcher`** — plug in new registry sources (CDN, local YAML, bundled seed)
- **`IModelRegistryCache`** — swap cache backends (file system, localStorage, in-memory)

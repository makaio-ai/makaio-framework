---
title: "modelRegistry"
editUrl: false
prev: false
next: false
---

# `modelRegistry`

| Field | Value |
|-------|-------|
| Prefix | `modelRegistry` |
| Namespace constant | `ModelRegistryNamespace` |
| Subjects constant | `ModelRegistrySubjects` |
| Kind | bus |
| Schema record | `ModelRegistrySchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`packages/services/core/src/model-registry/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `changed` | [`modelRegistry.changed`](#modelRegistry.changed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/schemas.ts) |
| `checkModelInProviders` | [`modelRegistry.checkModelInProviders`](#modelRegistry.checkModelInProviders) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/schemas.ts) |
| `getForProvider` | [`modelRegistry.getForProvider`](#modelRegistry.getForProvider) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/schemas.ts) |
| `getLabModels` | [`modelRegistry.getLabModels`](#modelRegistry.getLabModels) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/schemas.ts) |
| `getProviderModels` | [`modelRegistry.getProviderModels`](#modelRegistry.getProviderModels) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/schemas.ts) |
| `refresh` | [`modelRegistry.refresh`](#modelRegistry.refresh) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/model-registry/schemas.ts) |

## Subject Details

### <a id="modelRegistry.changed"></a>`modelRegistry.changed` (event)

Broadcast that the registry has been refreshed and committed.

Fire-and-forget event used by consumers that need to rescan registry-backed
capabilities after a successful refresh.

Subject: `modelRegistry.changed`
Type: Event

_Empty object._

### <a id="modelRegistry.checkModelInProviders"></a>`modelRegistry.checkModelInProviders` (rpc)

Batch-check model availability across multiple providers in a single RPC.

Accepts an array of provider IDs and a canonical lab model name. Returns a map of
`providerId → resolved ProviderAIModel` containing only the providers
that have the model. Providers absent from the registry or that do not
list the model are omitted from the result.

Use this subject instead of calling `getForProvider` in a loop — it
collapses N sequential RPCs into a single bus request.

Subject: `modelRegistry.checkModelInProviders`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `model` | `string` | yes |
| `providerIds` | `string[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `matches` | `Record<string, { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }>` | yes |

### <a id="modelRegistry.getForProvider"></a>`modelRegistry.getForProvider` (rpc)

Resolve a single model by provider and provider-native model ID.

Returns the merged model descriptor (lab definition + provider overrides),
or `undefined` if the model is not found for the given provider.

Subject: `modelRegistry.getForProvider`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `model` | `string` | yes |
| `providerId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `model` | `{ name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; } \| undefined` | no |

### <a id="modelRegistry.getLabModels"></a>`modelRegistry.getLabModels` (rpc)

List all canonical model definitions published by a lab.

Returns the full lab model array without any provider-specific overrides.

Subject: `modelRegistry.getLabModels`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `labId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `models` | `{ name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]` | yes |

### <a id="modelRegistry.getProviderModels"></a>`modelRegistry.getProviderModels` (rpc)

List all models available from a provider (merged with lab definitions).

Returns the full merged model list for the provider — lab defaults with
provider-specific overrides applied.

Subject: `modelRegistry.getProviderModels`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `providerId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `models` | `{ name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]` | yes |

### <a id="modelRegistry.refresh"></a>`modelRegistry.refresh` (rpc)

Force refresh of the model registry from remote source.
Fetches latest registry and updates cache.

Subject: `modelRegistry.refresh`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

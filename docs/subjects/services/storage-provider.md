---
title: "storage:provider"
editUrl: false
prev: false
next: false
---

# `storage:provider`

| Field | Value |
|-------|-------|
| Prefix | `storage:provider` |
| Namespace constant | `ProviderStorageNamespace` |
| Subjects constant | `ProviderStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/settings/storage/providers-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/settings/storage/providers-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `get` | [`storage:provider.get`](#storage:provider.get) | rpc | — |
| `list` | [`storage:provider.list`](#storage:provider.list) | rpc | — |
| `listByProtocol` | [`storage:provider.listByProtocol`](#storage:provider.listByProtocol) | rpc | — |

## Subject Details

### <a id="storage:provider.get"></a>`storage:provider.get` (rpc)

Subject: `storage:provider.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `provider` | `{ id: string; packageName: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; defaultModelFilterMode: "allowlist" \| "show-all"; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; credentialEnvVars?: Record<string, string> \| undefined; capabilities?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="storage:provider.list"></a>`storage:provider.list` (rpc)

Subject: `storage:provider.list`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `providers` | `{ id: string; packageName: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; defaultModelFilterMode: "allowlist" \| "show-all"; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; credentialEnvVars?: Record<string, string> \| undefined; capabilities?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="storage:provider.listByProtocol"></a>`storage:provider.listByProtocol` (rpc)

Subject: `storage:provider.listByProtocol`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `protocol` | `"anthropic" \| "openai"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `providers` | `{ id: string; packageName: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; defaultModelFilterMode: "allowlist" \| "show-all"; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; credentialEnvVars?: Record<string, string> \| undefined; capabilities?: Record<string, unknown> \| undefined; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

---
title: "adapterSubsystem"
editUrl: false
prev: false
next: false
---

# `adapterSubsystem`

| Field | Value |
|-------|-------|
| Prefix | `adapterSubsystem` |
| Namespace constant | `AdapterSubsystemNamespace` |
| Subjects constant | `AdapterSubsystemSubjects` |
| Kind | bus |
| Schema record | `AdapterSubsystemSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`packages/services/core/src/adapter-subsystem/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `adapter.registered` | [`adapterSubsystem.adapter.registered`](#adapterSubsystem.adapter.registered) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `bind` | [`adapterSubsystem.bind`](#adapterSubsystem.bind) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `binding.created` | [`adapterSubsystem.binding.created`](#adapterSubsystem.binding.created) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `binding.defaultChanged` | [`adapterSubsystem.binding.defaultChanged`](#adapterSubsystem.binding.defaultChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `binding.deleted` | [`adapterSubsystem.binding.deleted`](#adapterSubsystem.binding.deleted) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `buildProviderContext` | [`adapterSubsystem.buildProviderContext`](#adapterSubsystem.buildProviderContext) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `createProviderConfig` | [`adapterSubsystem.createProviderConfig`](#adapterSubsystem.createProviderConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `deleteProviderConfig` | [`adapterSubsystem.deleteProviderConfig`](#adapterSubsystem.deleteProviderConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `ensureReady` | [`adapterSubsystem.ensureReady`](#adapterSubsystem.ensureReady) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `findConfigForDefinitionAndAdapter` | [`adapterSubsystem.findConfigForDefinitionAndAdapter`](#adapterSubsystem.findConfigForDefinitionAndAdapter) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `getAdapterConfig` | [`adapterSubsystem.getAdapterConfig`](#adapterSubsystem.getAdapterConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `getDefaultBinding` | [`adapterSubsystem.getDefaultBinding`](#adapterSubsystem.getDefaultBinding) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `getProviderConfig` | [`adapterSubsystem.getProviderConfig`](#adapterSubsystem.getProviderConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `getProviderDefinitionsByAdapter` | [`adapterSubsystem.getProviderDefinitionsByAdapter`](#adapterSubsystem.getProviderDefinitionsByAdapter) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `listAdapterConfigs` | [`adapterSubsystem.listAdapterConfigs`](#adapterSubsystem.listAdapterConfigs) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `listAdapters` | [`adapterSubsystem.listAdapters`](#adapterSubsystem.listAdapters) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `listBindings` | [`adapterSubsystem.listBindings`](#adapterSubsystem.listBindings) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `listBindingsByConfig` | [`adapterSubsystem.listBindingsByConfig`](#adapterSubsystem.listBindingsByConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `listProviderConfigs` | [`adapterSubsystem.listProviderConfigs`](#adapterSubsystem.listProviderConfigs) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `listProviderConfigsByDefinition` | [`adapterSubsystem.listProviderConfigsByDefinition`](#adapterSubsystem.listProviderConfigsByDefinition) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `providerConfig.created` | [`adapterSubsystem.providerConfig.created`](#adapterSubsystem.providerConfig.created) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `providerConfig.defaultChanged` | [`adapterSubsystem.providerConfig.defaultChanged`](#adapterSubsystem.providerConfig.defaultChanged) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `providerConfig.deleted` | [`adapterSubsystem.providerConfig.deleted`](#adapterSubsystem.providerConfig.deleted) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `providerConfig.updated` | [`adapterSubsystem.providerConfig.updated`](#adapterSubsystem.providerConfig.updated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `ready` | [`adapterSubsystem.ready`](#adapterSubsystem.ready) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `setAdapterConfig` | [`adapterSubsystem.setAdapterConfig`](#adapterSubsystem.setAdapterConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `setAdapterEnabled` | [`adapterSubsystem.setAdapterEnabled`](#adapterSubsystem.setAdapterEnabled) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `setDefaultBinding` | [`adapterSubsystem.setDefaultBinding`](#adapterSubsystem.setDefaultBinding) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `setDefaultProviderConfig` | [`adapterSubsystem.setDefaultProviderConfig`](#adapterSubsystem.setDefaultProviderConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `setModelFilterMode` | [`adapterSubsystem.setModelFilterMode`](#adapterSubsystem.setModelFilterMode) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `setProviderConfigCredentialRefs` | [`adapterSubsystem.setProviderConfigCredentialRefs`](#adapterSubsystem.setProviderConfigCredentialRefs) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `unbind` | [`adapterSubsystem.unbind`](#adapterSubsystem.unbind) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |
| `updateProviderConfig` | [`adapterSubsystem.updateProviderConfig`](#adapterSubsystem.updateProviderConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/adapter-subsystem/schemas.ts) |

## Subject Details

### <a id="adapterSubsystem.adapter.registered"></a>`adapterSubsystem.adapter.registered` (event)

Emitted once per adapter after the adapter-subsystem service processes a
newly-active adapter package.

Replaces the retired batch `adaptersRegistered` event. The model registry
and other subscribers react per-adapter and debounce refreshes as needed.

Fire-and-forget; no replay guarantee.

Subject: `adapterSubsystem.adapter.registered`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `displayName` | `string` | yes |
| `enabled` | `boolean` | yes |
| `initialized` | `boolean` | yes |
| `packageName` | `string` | yes |
| `providerDefinitionIds` | `string[]` | yes |

### <a id="adapterSubsystem.bind"></a>`adapterSubsystem.bind` (rpc)

Bind a provider config to an adapter.

Subject: `adapterSubsystem.bind`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `providerConfigId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `binding` | `{ adapterName: string; providerConfigId: string; isDefault: boolean; }` | yes |

### <a id="adapterSubsystem.binding.created"></a>`adapterSubsystem.binding.created` (event)

Binding lifecycle events.

Subject: `adapterSubsystem.binding.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `providerConfigId` | `string` | yes |

### <a id="adapterSubsystem.binding.defaultChanged"></a>`adapterSubsystem.binding.defaultChanged` (event)

Subject: `adapterSubsystem.binding.defaultChanged`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `providerConfigId` | `string` | yes |

### <a id="adapterSubsystem.binding.deleted"></a>`adapterSubsystem.binding.deleted` (event)

Subject: `adapterSubsystem.binding.deleted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `providerConfigId` | `string` | yes |

### <a id="adapterSubsystem.buildProviderContext"></a>`adapterSubsystem.buildProviderContext` (rpc)

Build a provider context from a provider config.

Subject: `adapterSubsystem.buildProviderContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `providerConfigId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `context` | `{ providerConfigId: string; definitionId: string; credentialRefs: Record<string, string & $brand<"CredentialRef">>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; } \| null` | yes |

### <a id="adapterSubsystem.createProviderConfig"></a>`adapterSubsystem.createProviderConfig` (rpc)

Create a provider config.

Subject: `adapterSubsystem.createProviderConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `credentialRefs` | `Record<string, string & $brand<"CredentialRef">> \| undefined` | no |
| `definitionId` | `string` | yes |
| `endpointOverrides` | `{ anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined` | no |
| `isSentinel` | `boolean \| undefined` | no |
| `modelFilterMode` | `"allowlist" \| "show-all" \| undefined` | no |
| `modelVisibility` | `Record<string, "enabled" \| "disabled" \| "visible"> \| undefined` | no |
| `name` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }` | yes |

### <a id="adapterSubsystem.deleteProviderConfig"></a>`adapterSubsystem.deleteProviderConfig` (rpc)

Delete a provider config.

Subject: `adapterSubsystem.deleteProviderConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="adapterSubsystem.ensureReady"></a>`adapterSubsystem.ensureReady` (rpc)

Ensure the subsystem is ready for grain-constrained consumers.

Subject: `adapterSubsystem.ensureReady`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `ready` | `true` | yes |

### <a id="adapterSubsystem.findConfigForDefinitionAndAdapter"></a>`adapterSubsystem.findConfigForDefinitionAndAdapter` (rpc)

Find the provider config bound to a specific adapter for a definition.

Subject: `adapterSubsystem.findConfigForDefinitionAndAdapter`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `definitionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; } \| null` | yes |

### <a id="adapterSubsystem.getAdapterConfig"></a>`adapterSubsystem.getAdapterConfig` (rpc)

Get one adapter config by adapter name.

Subject: `adapterSubsystem.getAdapterConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ name: string; enabled: boolean; bindings: { adapterName: string; providerConfigId: string; isDefault: boolean; }[]; description?: string \| undefined; clientId?: string \| undefined; displayName?: string \| undefined; protocol?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="adapterSubsystem.getDefaultBinding"></a>`adapterSubsystem.getDefaultBinding` (rpc)

Get the default binding for an adapter.

Subject: `adapterSubsystem.getDefaultBinding`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `binding` | `{ adapterName: string; providerConfigId: string; isDefault: boolean; } \| null` | yes |

### <a id="adapterSubsystem.getProviderConfig"></a>`adapterSubsystem.getProviderConfig` (rpc)

Get one provider config by ID.

Subject: `adapterSubsystem.getProviderConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; } \| null` | yes |

### <a id="adapterSubsystem.getProviderDefinitionsByAdapter"></a>`adapterSubsystem.getProviderDefinitionsByAdapter` (rpc)

Get provider definitions contributed by a specific adapter.

Returns the full provider definition array for the named adapter, including
the registry-populated `availableModels` set at boot time.

Subject: `adapterSubsystem.getProviderDefinitionsByAdapter`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `definitions` | `{ id: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; defaultModelFilterMode?: "allowlist" \| "show-all" \| undefined; credentialEnvVars?: Record<string, string> \| undefined; }[]` | yes |

### <a id="adapterSubsystem.listAdapterConfigs"></a>`adapterSubsystem.listAdapterConfigs` (rpc)

List all adapter configs.

Subject: `adapterSubsystem.listAdapterConfigs`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `configs` | `{ name: string; enabled: boolean; bindings: { adapterName: string; providerConfigId: string; isDefault: boolean; }[]; description?: string \| undefined; clientId?: string \| undefined; displayName?: string \| undefined; protocol?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="adapterSubsystem.listAdapters"></a>`adapterSubsystem.listAdapters` (rpc)

List effective adapters.

Subject: `adapterSubsystem.listAdapters`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapters` | `{ name: string; displayName: string; enabled: boolean; configCount: number; readiness: "ready" \| "needs-setup"; supportsLogImport: boolean; description?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; clientId?: string \| undefined; protocol?: string \| undefined; providerDefinitionIds?: string[] \| undefined; }[]` | yes |

### <a id="adapterSubsystem.listBindings"></a>`adapterSubsystem.listBindings` (rpc)

List bindings for an adapter.

Subject: `adapterSubsystem.listBindings`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `bindings` | `{ adapterName: string; providerConfigId: string; isDefault: boolean; }[]` | yes |

### <a id="adapterSubsystem.listBindingsByConfig"></a>`adapterSubsystem.listBindingsByConfig` (rpc)

List bindings for a provider config.

Subject: `adapterSubsystem.listBindingsByConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `providerConfigId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `bindings` | `{ adapterName: string; providerConfigId: string; isDefault: boolean; }[]` | yes |

### <a id="adapterSubsystem.listProviderConfigs"></a>`adapterSubsystem.listProviderConfigs` (rpc)

List provider configs, optionally filtering by enabled state.

Subject: `adapterSubsystem.listProviderConfigs`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `enabled` | `boolean \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `configs` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }[]` | yes |

### <a id="adapterSubsystem.listProviderConfigsByDefinition"></a>`adapterSubsystem.listProviderConfigsByDefinition` (rpc)

List provider configs for a given provider definition.

Subject: `adapterSubsystem.listProviderConfigsByDefinition`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `definitionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `configs` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }[]` | yes |

### <a id="adapterSubsystem.providerConfig.created"></a>`adapterSubsystem.providerConfig.created` (event)

Provider config lifecycle events.

Subject: `adapterSubsystem.providerConfig.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `definitionId` | `string` | yes |
| `enabled` | `boolean` | yes |
| `endpointOverrides` | `Record<string, string> \| undefined` | no |
| `hasCredentials` | `boolean` | yes |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `isSentinel` | `boolean` | yes |
| `modelFilterMode` | `"allowlist" \| "show-all"` | yes |
| `modelVisibility` | `Record<string, "enabled" \| "disabled" \| "visible"> \| undefined` | no |
| `name` | `string` | yes |
| `sourceRef` | `string \| undefined` | no |

### <a id="adapterSubsystem.providerConfig.defaultChanged"></a>`adapterSubsystem.providerConfig.defaultChanged` (event)

Subject: `adapterSubsystem.providerConfig.defaultChanged`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `configId` | `string \| null` | yes |
| `definitionId` | `string` | yes |

### <a id="adapterSubsystem.providerConfig.deleted"></a>`adapterSubsystem.providerConfig.deleted` (event)

Subject: `adapterSubsystem.providerConfig.deleted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="adapterSubsystem.providerConfig.updated"></a>`adapterSubsystem.providerConfig.updated` (event)

Bus-safe provider config read model.

Generic reads intentionally exclude credential refs. Runtime assembly goes
through `buildProviderContext` instead.

Subject: `adapterSubsystem.providerConfig.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `definitionId` | `string` | yes |
| `enabled` | `boolean` | yes |
| `endpointOverrides` | `Record<string, string> \| undefined` | no |
| `hasCredentials` | `boolean` | yes |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `isSentinel` | `boolean` | yes |
| `modelFilterMode` | `"allowlist" \| "show-all"` | yes |
| `modelVisibility` | `Record<string, "enabled" \| "disabled" \| "visible"> \| undefined` | no |
| `name` | `string` | yes |
| `sourceRef` | `string \| undefined` | no |

### <a id="adapterSubsystem.ready"></a>`adapterSubsystem.ready` (event)

Readiness observability event (fire-and-forget, no replay guarantee).

Listeners registered after the subsystem emits this event will miss it.
Use `ensureReady` (request/response) for reliable coordination.

Subject: `adapterSubsystem.ready`
Type: Event

_Empty object._

### <a id="adapterSubsystem.setAdapterConfig"></a>`adapterSubsystem.setAdapterConfig` (rpc)

Set adapter config fields.

Subject: `adapterSubsystem.setAdapterConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |
| `patch` | `{ displayName?: string \| undefined; description?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; clientId?: string \| undefined; protocol?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; enabled?: boolean \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ name: string; enabled: boolean; bindings: { adapterName: string; providerConfigId: string; isDefault: boolean; }[]; description?: string \| undefined; clientId?: string \| undefined; displayName?: string \| undefined; protocol?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; }` | yes |

### <a id="adapterSubsystem.setAdapterEnabled"></a>`adapterSubsystem.setAdapterEnabled` (rpc)

Enable or disable an adapter config.

Subject: `adapterSubsystem.setAdapterEnabled`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `enabled` | `boolean` | yes |
| `name` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="adapterSubsystem.setDefaultBinding"></a>`adapterSubsystem.setDefaultBinding` (rpc)

Set the default binding for an adapter.

Subject: `adapterSubsystem.setDefaultBinding`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `providerConfigId` | `string` | yes |

**Response:**

_Empty object._

### <a id="adapterSubsystem.setDefaultProviderConfig"></a>`adapterSubsystem.setDefaultProviderConfig` (rpc)

Set the default provider config for its definition.

Subject: `adapterSubsystem.setDefaultProviderConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }` | yes |

### <a id="adapterSubsystem.setModelFilterMode"></a>`adapterSubsystem.setModelFilterMode` (rpc)

Set the model filter mode for a provider config.

Subject: `adapterSubsystem.setModelFilterMode`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |
| `modelFilterMode` | `"allowlist" \| "show-all"` | yes |
| `preferredModel` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }` | yes |

### <a id="adapterSubsystem.setProviderConfigCredentialRefs"></a>`adapterSubsystem.setProviderConfigCredentialRefs` (rpc)

Replace the canonical credential refs for one provider config.

Subject: `adapterSubsystem.setProviderConfigCredentialRefs`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `credentialRefs` | `Record<string, string & $brand<"CredentialRef">>` | yes |
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }` | yes |

### <a id="adapterSubsystem.unbind"></a>`adapterSubsystem.unbind` (rpc)

Unbind a provider config from an adapter.

Subject: `adapterSubsystem.unbind`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `providerConfigId` | `string` | yes |

**Response:**

_Empty object._

### <a id="adapterSubsystem.updateProviderConfig"></a>`adapterSubsystem.updateProviderConfig` (rpc)

Update a provider config.

Subject: `adapterSubsystem.updateProviderConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |
| `patch` | `{ name?: string \| undefined; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| null \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; enabled?: boolean \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; isSentinel: boolean; hasCredentials: boolean; endpointOverrides?: Record<string, string> \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; sourceRef?: string \| undefined; }` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

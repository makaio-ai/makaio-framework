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
| Defined in | [`services/core/src/adapter-subsystem/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `adapter.registered` | [`adapterSubsystem.adapter.registered`](#adapterSubsystem.adapter.registered) | event | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `bind` | [`adapterSubsystem.bind`](#adapterSubsystem.bind) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `binding.created` | [`adapterSubsystem.binding.created`](#adapterSubsystem.binding.created) | event | [`runtime-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/runtime-schemas.ts) |
| `binding.defaultChanged` | [`adapterSubsystem.binding.defaultChanged`](#adapterSubsystem.binding.defaultChanged) | event | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `binding.deleted` | [`adapterSubsystem.binding.deleted`](#adapterSubsystem.binding.deleted) | event | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `createProviderConfig` | [`adapterSubsystem.createProviderConfig`](#adapterSubsystem.createProviderConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `deleteProviderConfig` | [`adapterSubsystem.deleteProviderConfig`](#adapterSubsystem.deleteProviderConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `ensureReady` | [`adapterSubsystem.ensureReady`](#adapterSubsystem.ensureReady) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `findConfigForDefinitionAndAdapter` | [`adapterSubsystem.findConfigForDefinitionAndAdapter`](#adapterSubsystem.findConfigForDefinitionAndAdapter) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `getAdapterConfig` | [`adapterSubsystem.getAdapterConfig`](#adapterSubsystem.getAdapterConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `getDefaultBinding` | [`adapterSubsystem.getDefaultBinding`](#adapterSubsystem.getDefaultBinding) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `getProviderConfig` | [`adapterSubsystem.getProviderConfig`](#adapterSubsystem.getProviderConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `getProviderDefinitionsByAdapter` | [`adapterSubsystem.getProviderDefinitionsByAdapter`](#adapterSubsystem.getProviderDefinitionsByAdapter) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listAdapterConfigs` | [`adapterSubsystem.listAdapterConfigs`](#adapterSubsystem.listAdapterConfigs) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listAdapters` | [`adapterSubsystem.listAdapters`](#adapterSubsystem.listAdapters) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listBindings` | [`adapterSubsystem.listBindings`](#adapterSubsystem.listBindings) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listBindingsByConfig` | [`adapterSubsystem.listBindingsByConfig`](#adapterSubsystem.listBindingsByConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listCompatibleAuthOptions` | [`adapterSubsystem.listCompatibleAuthOptions`](#adapterSubsystem.listCompatibleAuthOptions) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listProviderConfigs` | [`adapterSubsystem.listProviderConfigs`](#adapterSubsystem.listProviderConfigs) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `listProviderConfigsByDefinition` | [`adapterSubsystem.listProviderConfigsByDefinition`](#adapterSubsystem.listProviderConfigsByDefinition) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `providerConfig.created` | [`adapterSubsystem.providerConfig.created`](#adapterSubsystem.providerConfig.created) | event | [`runtime-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/runtime-schemas.ts) |
| `providerConfig.defaultChanged` | [`adapterSubsystem.providerConfig.defaultChanged`](#adapterSubsystem.providerConfig.defaultChanged) | event | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `providerConfig.deleted` | [`adapterSubsystem.providerConfig.deleted`](#adapterSubsystem.providerConfig.deleted) | event | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `providerConfig.updated` | [`adapterSubsystem.providerConfig.updated`](#adapterSubsystem.providerConfig.updated) | event | [`runtime-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/runtime-schemas.ts) |
| `ready` | [`adapterSubsystem.ready`](#adapterSubsystem.ready) | event | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `resolveAdapterRuntimeSnapshot` | [`adapterSubsystem.resolveAdapterRuntimeSnapshot`](#adapterSubsystem.resolveAdapterRuntimeSnapshot) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `resolveProviderRuntimeSnapshot` | [`adapterSubsystem.resolveProviderRuntimeSnapshot`](#adapterSubsystem.resolveProviderRuntimeSnapshot) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `setAdapterConfig` | [`adapterSubsystem.setAdapterConfig`](#adapterSubsystem.setAdapterConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `setAdapterEnabled` | [`adapterSubsystem.setAdapterEnabled`](#adapterSubsystem.setAdapterEnabled) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `setDefaultBinding` | [`adapterSubsystem.setDefaultBinding`](#adapterSubsystem.setDefaultBinding) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `setDefaultProviderConfig` | [`adapterSubsystem.setDefaultProviderConfig`](#adapterSubsystem.setDefaultProviderConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `setModelFilterMode` | [`adapterSubsystem.setModelFilterMode`](#adapterSubsystem.setModelFilterMode) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `setProviderConfigAuth` | [`adapterSubsystem.setProviderConfigAuth`](#adapterSubsystem.setProviderConfigAuth) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `unbind` | [`adapterSubsystem.unbind`](#adapterSubsystem.unbind) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |
| `updateProviderConfig` | [`adapterSubsystem.updateProviderConfig`](#adapterSubsystem.updateProviderConfig) | rpc | [`namespace-schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/adapter-subsystem/namespace-schemas.ts) |

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

### <a id="adapterSubsystem.createProviderConfig"></a>`adapterSubsystem.createProviderConfig` (rpc)

Create a provider config.

Subject: `adapterSubsystem.createProviderConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `auth` | `{ mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; }` | yes |
| `definitionId` | `string` | yes |
| `enabled` | `boolean \| undefined` | no |
| `endpointOverrides` | `{ anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined` | no |
| `managedBy` | `{ kind: "client"; clientId: string; } \| undefined` | no |
| `modelFilterMode` | `"allowlist" \| "show-all" \| undefined` | no |
| `modelVisibility` | `Record<string, "enabled" \| "disabled" \| "visible"> \| undefined` | no |
| `name` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }` | yes |

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
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; } \| null` | yes |

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
| `config` | `{ name: string; enabled: boolean; bindings: { adapterName: string; providerConfigId: string; isDefault: boolean; }[]; description?: string \| undefined; displayName?: string \| undefined; clientId?: string \| undefined; protocol?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; } \| null` | yes |

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
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; } \| null` | yes |

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
| `definitions` | `{ id: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; primaryTestModel?: string \| undefined; secondaryTestModel?: string \| undefined; defaultModelFilterMode?: "allowlist" \| "show-all" \| undefined; capabilities?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="adapterSubsystem.listAdapterConfigs"></a>`adapterSubsystem.listAdapterConfigs` (rpc)

List all adapter configs.

Subject: `adapterSubsystem.listAdapterConfigs`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `configs` | `{ name: string; enabled: boolean; bindings: { adapterName: string; providerConfigId: string; isDefault: boolean; }[]; description?: string \| undefined; displayName?: string \| undefined; clientId?: string \| undefined; protocol?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; }[]` | yes |

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

### <a id="adapterSubsystem.listCompatibleAuthOptions"></a>`adapterSubsystem.listCompatibleAuthOptions` (rpc)

List normalized authentication methods deliverable by loaded adapters for
one provider definition.

Subject: `adapterSubsystem.listCompatibleAuthOptions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `definitionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `options` | `({ definitionId: string; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; compatibleAdapterNames: string[]; portability: "portable"; description?: string \| undefined; } \| { definitionId: string; method: { owner: "client"; clientId: string; methodId: string; }; mode: "inferred"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; compatibleAdapterNames: string[]; portability: "local-only"; description?: string \| undefined; } \| { definitionId: string; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; mode: "none"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; compatibleAdapterNames: string[]; portability: "portable"; description?: string \| undefined; })[]` | yes |

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
| `configs` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }[]` | yes |

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
| `configs` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }[]` | yes |

### <a id="adapterSubsystem.providerConfig.created"></a>`adapterSubsystem.providerConfig.created` (event)

Provider config lifecycle events.

Subject: `adapterSubsystem.providerConfig.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `auth` | `{ mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }` | yes |
| `definitionId` | `string` | yes |
| `enabled` | `boolean` | yes |
| `endpointOverrides` | `{ anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `managedBy` | `{ kind: "client"; clientId: string; } \| undefined` | no |
| `modelFilterMode` | `"allowlist" \| "show-all"` | yes |
| `modelVisibility` | `Record<string, "enabled" \| "disabled" \| "visible"> \| undefined` | no |
| `name` | `string` | yes |

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

Bus-safe provider config read model that excludes credential references.

Subject: `adapterSubsystem.providerConfig.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `auth` | `{ mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }` | yes |
| `definitionId` | `string` | yes |
| `enabled` | `boolean` | yes |
| `endpointOverrides` | `{ anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `managedBy` | `{ kind: "client"; clientId: string; } \| undefined` | no |
| `modelFilterMode` | `"allowlist" \| "show-all"` | yes |
| `modelVisibility` | `Record<string, "enabled" \| "disabled" \| "visible"> \| undefined` | no |
| `name` | `string` | yes |

### <a id="adapterSubsystem.ready"></a>`adapterSubsystem.ready` (event)

Readiness observability event (fire-and-forget, no replay guarantee).

Listeners registered after the subsystem emits this event will miss it.
Use `ensureReady` (request/response) for reliable coordination.

Subject: `adapterSubsystem.ready`
Type: Event

_Empty object._

### <a id="adapterSubsystem.resolveAdapterRuntimeSnapshot"></a>`adapterSubsystem.resolveAdapterRuntimeSnapshot` (rpc)

Resolve provider state, exact adapter auth declarations, and runtime import
paths from one adapter-subsystem read.

Subject: `adapterSubsystem.resolveAdapterRuntimeSnapshot`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `providerConfigId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `status` | `"error" \| "resolved"` | yes |

### <a id="adapterSubsystem.resolveProviderRuntimeSnapshot"></a>`adapterSubsystem.resolveProviderRuntimeSnapshot` (rpc)

Resolve a safe config, refs-only context, and provider definition from one
captured runtime snapshot.

Subject: `adapterSubsystem.resolveProviderRuntimeSnapshot`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `providerConfigId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `snapshot` | `{ config: { id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }; context: { state: "resolved"; providerConfigId: string; definitionId: string; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; }; credentialRefs: Record<string, string & $brand<"CredentialRef">>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "inferred"; label: string; description?: string \| undefined; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "none"; label: string; description?: string \| undefined; }; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; capabilities?: Record<string, unknown> \| undefined; }; definition: { id: string; packageName: string; name: string; availableModels: { name: string; contextWindowSize: number; labId: string; friendlyName?: string \| undefined; family?: string \| undefined; supportedReasoningLevels?: { none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined; metadata?: { maxOutputTokens?: number \| undefined; capabilities?: { vision?: boolean \| undefined; toolCalling?: boolean \| undefined; parallelToolCalls?: boolean \| undefined; structuredOutput?: boolean \| undefined; pdfUpload?: boolean \| undefined; speechToText?: { modes: ("batch" \| "streaming")[]; vocabularyBiasing?: boolean \| undefined; } \| undefined; textToSpeech?: { modes: ("streaming" \| "buffered")[]; voiceSelection?: boolean \| undefined; voiceInstructions?: boolean \| undefined; outputFormats?: string[] \| undefined; } \| undefined; } \| undefined; pricing?: { token?: { inputPerMillion: number; outputPerMillion: number; inputCachedPerMillion?: number \| undefined; cacheWritePerMillion?: number \| undefined; } \| undefined; request?: { multiplier: number; } \| undefined; } \| undefined; includedInSubscription?: boolean \| undefined; description?: string \| undefined; } \| undefined; }[]; defaultModelFilterMode: "allowlist" \| "show-all"; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; endpoints?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; defaultModel?: string \| undefined; fastModel?: string \| undefined; capabilities?: Record<string, unknown> \| undefined; }; } \| null` | yes |

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
| `config` | `{ name: string; enabled: boolean; bindings: { adapterName: string; providerConfigId: string; isDefault: boolean; }[]; description?: string \| undefined; displayName?: string \| undefined; clientId?: string \| undefined; protocol?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; providerDefinitionIds?: string[] \| undefined; settings?: Record<string, unknown> \| undefined; }` | yes |

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
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }` | yes |

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
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }` | yes |

### <a id="adapterSubsystem.setProviderConfigAuth"></a>`adapterSubsystem.setProviderConfigAuth` (rpc)

Replace the complete authentication selection for one provider config.

Subject: `adapterSubsystem.setProviderConfigAuth`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `auth` | `{ mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; }` | yes |
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }` | yes |

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
| `config` | `{ id: string; definitionId: string; name: string; modelFilterMode: "allowlist" \| "show-all"; isDefault: boolean; enabled: boolean; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: true; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; hasCredentials: false; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; modelVisibility?: Record<string, "enabled" \| "disabled" \| "visible"> \| undefined; managedBy?: { kind: "client"; clientId: string; } \| undefined; }` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

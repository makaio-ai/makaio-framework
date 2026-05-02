---
title: "settings"
editUrl: false
prev: false
next: false
---

# `settings`

| Field | Value |
|-------|-------|
| Prefix | `settings` |
| Namespace constant | `SettingsNamespace` |
| Subjects constant | `SettingsSubjects` |
| Kind | bus |
| Schema record | `SettingsSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`packages/services/core/src/settings/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `adapter.defaults.get` | [`settings.adapter.defaults.get`](#settings.adapter.defaults.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `adapter.defaults.update` | [`settings.adapter.defaults.update`](#settings.adapter.defaults.update) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `adapter.getConfig` | [`settings.adapter.getConfig`](#settings.adapter.getConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `adapter.getConfigSchema` | [`settings.adapter.getConfigSchema`](#settings.adapter.getConfigSchema) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `adapter.list` | [`settings.adapter.list`](#settings.adapter.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `adapter.setEnabled` | [`settings.adapter.setEnabled`](#settings.adapter.setEnabled) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `adapter.updateConfig` | [`settings.adapter.updateConfig`](#settings.adapter.updateConfig) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `extension.getConfigSchema` | [`settings.extension.getConfigSchema`](#settings.extension.getConfigSchema) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `runtime.get` | [`settings.runtime.get`](#settings.runtime.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |
| `runtime.update` | [`settings.runtime.update`](#settings.runtime.update) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/settings/schemas.ts) |

## Subject Details

### <a id="settings.adapter.defaults.get"></a>`settings.adapter.defaults.get` (rpc)

Get adapter-level defaults (subject: `settings.adapter.defaults.get`)

Subject: `settings.adapter.defaults.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `credentials` | `Record<string, string & $brand<"CredentialRef">> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `env` | `Record<string, string> \| undefined` | no |
| `model` | `string \| undefined` | no |
| `providerSettings` | `Record<string, unknown> \| undefined` | no |
| `timeouts` | `Partial<RequiredTimeoutConfig> \| undefined` | no |

### <a id="settings.adapter.defaults.update"></a>`settings.adapter.defaults.update` (rpc)

Update adapter-level defaults (subject: `settings.adapter.defaults.update`)

Subject: `settings.adapter.defaults.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `defaults` | `{ model?: string \| undefined; timeouts?: Partial<RequiredTimeoutConfig> \| undefined; cwd?: string \| undefined; env?: Record<string, string> \| undefined; credentials?: Record<string, string & $brand<"CredentialRef">> \| undefined; providerSettings?: Record<string, unknown> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="settings.adapter.getConfig"></a>`settings.adapter.getConfig` (rpc)

Get adapter-wide configuration (subject: `settings.adapter.getConfig`)

Subject: `settings.adapter.getConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `Record<string, unknown>` | yes |

### <a id="settings.adapter.getConfigSchema"></a>`settings.adapter.getConfigSchema` (rpc)

Get JSON Schema for adapter's providerConfig (subject: `settings.adapter.getConfigSchema`)

Subject: `settings.adapter.getConfigSchema`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `hasSchema` | `boolean` | yes |
| `schema` | `Record<string, unknown> \| null` | yes |

### <a id="settings.adapter.list"></a>`settings.adapter.list` (rpc)

List all available adapter drivers (subject: `settings.adapter.list`)

Subject: `settings.adapter.list`
Type: Request (RPC)

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapters` | `{ adapterName: string; displayName: string; enabled: boolean; configCount: number; supportsLogImport: boolean; description?: string \| undefined; helpLinks?: { label: string; url: string; }[] \| undefined; instructions?: string \| undefined; readiness?: "ready" \| "needs-setup" \| "missing-credentials" \| undefined; clientId?: string \| undefined; protocol?: "anthropic" \| "openai" \| undefined; providerDefinitionIds?: string[] \| undefined; }[]` | yes |

### <a id="settings.adapter.setEnabled"></a>`settings.adapter.setEnabled` (rpc)

Enable or disable an adapter driver (subject: `settings.adapter.setEnabled`)

Subject: `settings.adapter.setEnabled`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `enabled` | `boolean` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="settings.adapter.updateConfig"></a>`settings.adapter.updateConfig` (rpc)

Update adapter-wide configuration (subject: `settings.adapter.updateConfig`)

Subject: `settings.adapter.updateConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `config` | `Record<string, unknown>` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="settings.extension.getConfigSchema"></a>`settings.extension.getConfigSchema` (rpc)

Get JSON Schema for extension's configSchema (subject: `settings.extension.getConfigSchema`)

Subject: `settings.extension.getConfigSchema`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `extensionName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `hasSchema` | `boolean` | yes |
| `schema` | `Record<string, unknown> \| null` | yes |
| `uiConfig` | `{ editMode: "inline" \| "slidePanel" \| "fullPage"; hiddenFields?: string[] \| undefined; readOnlyInEditMode?: string[] \| undefined; fieldOverrides?: Record<string, { widget?: string \| undefined; delimiter?: string \| undefined; placeholder?: string \| undefined; helpText?: string \| undefined; min?: number \| undefined; max?: number \| undefined; step?: number \| undefined; options?: { value: string; label: string; }[] \| undefined; }> \| undefined; sections?: { id: string; title: string; fields: string[]; description?: string \| undefined; }[] \| undefined; } \| null` | yes |

### <a id="settings.runtime.get"></a>`settings.runtime.get` (rpc)

Get current runtime configuration (subject: `settings.runtime.get`)

Subject: `settings.runtime.get`
Type: Request (RPC)

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `$schema` | `"makaio/config/v1"` | yes |
| `bus` | `{ remote?: { url?: string \| undefined; secret?: string \| undefined; } \| undefined; } \| undefined` | no |
| `features` | `{ voiceBridge: boolean; } \| undefined` | no |
| `fileWatcher` | `{ backend: "auto" \| "watchman" \| "parcel" \| "chokidar"; } \| undefined` | no |
| `mode` | `"local" \| "remote" \| "hybrid"` | yes |
| `relay` | `{ autoReconnect: boolean; maxReconnectAttempts: number; heartbeatInterval: number; url?: string \| undefined; token?: string \| undefined; } \| undefined` | no |
| `role` | `"server" \| "main-dev-machine"` | yes |

### <a id="settings.runtime.update"></a>`settings.runtime.update` (rpc)

Update runtime configuration (subject: `settings.runtime.update`)

Subject: `settings.runtime.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `$schema` | `"makaio/config/v1" \| undefined` | no |
| `bus` | `{ remote?: { url?: string \| undefined; secret?: string \| undefined; } \| undefined; } \| undefined` | no |
| `features` | `{ voiceBridge: boolean; } \| undefined` | no |
| `fileWatcher` | `{ backend: "auto" \| "watchman" \| "parcel" \| "chokidar"; } \| undefined` | no |
| `mode` | `"local" \| "remote" \| "hybrid" \| undefined` | no |
| `relay` | `{ autoReconnect: boolean; maxReconnectAttempts: number; heartbeatInterval: number; url?: string \| undefined; token?: string \| undefined; } \| undefined` | no |
| `role` | `"server" \| "main-dev-machine" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

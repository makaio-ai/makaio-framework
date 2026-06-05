---
title: "settings:subagentTemplate"
editUrl: false
prev: false
next: false
---

# `settings:subagentTemplate`

| Field | Value |
|-------|-------|
| Prefix | `settings:subagentTemplate` |
| Namespace constant | `SubagentTemplateSettingsNamespace` |
| Subjects constant | `SubagentTemplateSettingsSubjects` |
| Kind | bus |
| Schema record | `SubagentTemplateSettingsSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/settings/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/settings/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `create` | [`settings:subagentTemplate.create`](#settings:subagentTemplate.create) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/subagent-template/schemas.ts) |
| `delete` | [`settings:subagentTemplate.delete`](#settings:subagentTemplate.delete) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/subagent-template/schemas.ts) |
| `get` | [`settings:subagentTemplate.get`](#settings:subagentTemplate.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/subagent-template/schemas.ts) |
| `list` | [`settings:subagentTemplate.list`](#settings:subagentTemplate.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/subagent-template/schemas.ts) |
| `update` | [`settings:subagentTemplate.update`](#settings:subagentTemplate.update) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/subagent-template/schemas.ts) |

## Subject Details

### <a id="settings:subagentTemplate.create"></a>`settings:subagentTemplate.create` (rpc)

Subject: `settings:subagentTemplate.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `allowedDirectories` | `string[] \| undefined` | no |
| `allowedTools` | `string[] \| undefined` | no |
| `contextMode` | `"fork" \| "fresh" \| undefined` | no |
| `disallowedTools` | `string[] \| undefined` | no |
| `enabled` | `boolean \| undefined` | no |
| `model` | `string \| undefined` | no |
| `name` | `string` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `systemPrompt` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="settings:subagentTemplate.delete"></a>`settings:subagentTemplate.delete` (rpc)

Subject: `settings:subagentTemplate.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="settings:subagentTemplate.get"></a>`settings:subagentTemplate.get` (rpc)

Subject: `settings:subagentTemplate.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string \| undefined` | no |
| `name` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `allowedDirectories` | `string[] \| undefined` | no |
| `allowedTools` | `string[] \| undefined` | no |
| `contextMode` | `"fork" \| "fresh"` | yes |
| `createdAt` | `number` | yes |
| `disallowedTools` | `string[] \| undefined` | no |
| `enabled` | `boolean` | yes |
| `id` | `string` | yes |
| `model` | `string \| undefined` | no |
| `name` | `string` | yes |
| `providerConfigId` | `string \| undefined` | no |
| `scope` | `string` | yes |
| `systemPrompt` | `string \| undefined` | no |
| `updatedAt` | `number` | yes |

### <a id="settings:subagentTemplate.list"></a>`settings:subagentTemplate.list` (rpc)

Subject: `settings:subagentTemplate.list`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `definitions` | `{ id: string; name: string; adapterName: string; enabled: boolean; model?: string \| undefined; }[]` | yes |

### <a id="settings:subagentTemplate.update"></a>`settings:subagentTemplate.update` (rpc)

Subject: `settings:subagentTemplate.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `allowedDirectories` | `string[] \| undefined` | no |
| `allowedTools` | `string[] \| undefined` | no |
| `contextMode` | `"fork" \| "fresh" \| undefined` | no |
| `createdAt` | `number \| undefined` | no |
| `disallowedTools` | `string[] \| undefined` | no |
| `enabled` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `model` | `string \| undefined` | no |
| `name` | `string \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `scope` | `string \| undefined` | no |
| `systemPrompt` | `string \| undefined` | no |
| `updatedAt` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

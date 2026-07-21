---
title: "execution-target"
editUrl: false
prev: false
next: false
---

# `execution-target`

| Field | Value |
|-------|-------|
| Prefix | `execution-target` |
| Namespace constant | `ExecutionTargetNamespace` |
| Subjects constant | `ExecutionTargetSubjects` |
| Kind | bus |
| Schema record | `ExecutionTargetSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/execution-target/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `created` | [`execution-target.created`](#execution-target.created) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `delete` | [`execution-target.delete`](#execution-target.delete) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `deleted` | [`execution-target.deleted`](#execution-target.deleted) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `get` | [`execution-target.get`](#execution-target.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `list` | [`execution-target.list`](#execution-target.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `resolve` | [`execution-target.resolve`](#execution-target.resolve) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `set` | [`execution-target.set`](#execution-target.set) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |
| `updated` | [`execution-target.updated`](#execution-target.updated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/execution-target/schemas.ts) |

## Subject Details

### <a id="execution-target.created"></a>`execution-target.created` (event)

Subject: `execution-target.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `busMode` | `"relay" \| "host" \| undefined` | no |
| `busUrl` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `gitCredentialMode` | `"token" \| "ssh-agent" \| undefined` | no |
| `id` | `string` | yes |
| `image` | `string \| undefined` | no |
| `name` | `string` | yes |
| `relayUrl` | `string \| undefined` | no |
| `repoUrl` | `string \| undefined` | no |
| `scope` | `string` | yes |
| `type` | `"local" \| "container-local" \| "container-isolated"` | yes |
| `updatedAt` | `number` | yes |

### <a id="execution-target.delete"></a>`execution-target.delete` (rpc)

Subject: `execution-target.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="execution-target.deleted"></a>`execution-target.deleted` (event)

Subject: `execution-target.deleted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="execution-target.get"></a>`execution-target.get` (rpc)

Subject: `execution-target.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionTarget` | `{ id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "local"; description?: string \| undefined; } \| { id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "container-local"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; busUrl?: string \| undefined; } \| { id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "container-isolated"; busMode: "relay" \| "host"; gitCredentialMode: "token" \| "ssh-agent"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; relayUrl?: string \| undefined; repoUrl?: string \| undefined; } \| null` | yes |

### <a id="execution-target.list"></a>`execution-target.list` (rpc)

Subject: `execution-target.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `scope` | `string \| undefined` | no |
| `type` | `"local" \| "container-local" \| "container-isolated" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionTargets` | `({ id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "local"; description?: string \| undefined; } \| { id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "container-local"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; busUrl?: string \| undefined; } \| { id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "container-isolated"; busMode: "relay" \| "host"; gitCredentialMode: "token" \| "ssh-agent"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; relayUrl?: string \| undefined; repoUrl?: string \| undefined; })[]` | yes |

### <a id="execution-target.resolve"></a>`execution-target.resolve` (rpc)

Subject: `execution-target.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionTargetId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionTarget` | `{ id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "local"; description?: string \| undefined; } \| { id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "container-local"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; busUrl?: string \| undefined; } \| { id: string; name: string; scope: string; enabled: boolean; createdAt: number; updatedAt: number; type: "container-isolated"; busMode: "relay" \| "host"; gitCredentialMode: "token" \| "ssh-agent"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; relayUrl?: string \| undefined; repoUrl?: string \| undefined; }` | yes |

### <a id="execution-target.set"></a>`execution-target.set` (rpc)

Subject: `execution-target.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionTarget` | `{ type: "local"; id: string; scope: string; name: string; enabled: boolean; description?: string \| undefined; } \| { type: "container-local"; id: string; scope: string; name: string; enabled: boolean; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; busUrl?: string \| undefined; } \| { type: "container-isolated"; id: string; scope: string; name: string; enabled: boolean; busMode: "relay" \| "host"; description?: string \| undefined; image?: string \| undefined; env?: Record<string, string> \| undefined; relayUrl?: string \| undefined; gitCredentialMode?: "token" \| "ssh-agent" \| undefined; repoUrl?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="execution-target.updated"></a>`execution-target.updated` (event)

Subject: `execution-target.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `busMode` | `"relay" \| "host" \| undefined` | no |
| `busUrl` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `gitCredentialMode` | `"token" \| "ssh-agent" \| undefined` | no |
| `id` | `string` | yes |
| `image` | `string \| undefined` | no |
| `name` | `string` | yes |
| `relayUrl` | `string \| undefined` | no |
| `repoUrl` | `string \| undefined` | no |
| `scope` | `string` | yes |
| `type` | `"local" \| "container-local" \| "container-isolated"` | yes |
| `updatedAt` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

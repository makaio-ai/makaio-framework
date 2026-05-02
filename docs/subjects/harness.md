---
title: "harness"
editUrl: false
prev: false
next: false
---

# `harness`

| Field | Value |
|-------|-------|
| Prefix | `harness` |
| Namespace constant | `HarnessNamespace` |
| Subjects constant | `HarnessSubjects` |
| Kind | bus |
| Schema record | `HarnessSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/harness/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/harness/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `created` | [`harness.created`](#harness.created) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/harness/schemas.ts) |
| `delete` | [`harness.delete`](#harness.delete) | rpc | — |
| `deleted` | [`harness.deleted`](#harness.deleted) | event | — |
| `get` | [`harness.get`](#harness.get) | rpc | — |
| `getDefault` | [`harness.getDefault`](#harness.getDefault) | rpc | — |
| `getSchema` | [`harness.getSchema`](#harness.getSchema) | rpc | — |
| `list` | [`harness.list`](#harness.list) | rpc | — |
| `resolve` | [`harness.resolve`](#harness.resolve) | rpc | — |
| `set` | [`harness.set`](#harness.set) | rpc | — |
| `updated` | [`harness.updated`](#harness.updated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/harness/schemas.ts) |

## Subject Details

### <a id="harness.created"></a>`harness.created` (event)

Emitted after a new harness definition is inserted.

Subject: `harness.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `approvalPolicy` | `"reject" \| "always-ask" \| "full-access"` | yes |
| `capabilityOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `credentials` | `Record<string, string> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `name` | `string` | yes |
| `nativeTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `registryTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `skills` | `{ enabled: string[]; disabled: string[]; } \| undefined` | no |
| `toolApprovalOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `toolCapabilityMap` | `Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined` | no |
| `updatedAt` | `number` | yes |

### <a id="harness.delete"></a>`harness.delete` (rpc)

Subject: `harness.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="harness.deleted"></a>`harness.deleted` (event)

Emitted after a harness definition is deleted.

Subject: `harness.deleted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="harness.get"></a>`harness.get` (rpc)

Subject: `harness.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `id` | `string \| undefined` | no |
| `name` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `approvalPolicy` | `"reject" \| "always-ask" \| "full-access"` | yes |
| `capabilityOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `credentials` | `Record<string, string> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `name` | `string` | yes |
| `nativeTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `registryTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `skills` | `{ enabled: string[]; disabled: string[]; } \| undefined` | no |
| `toolApprovalOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `toolCapabilityMap` | `Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined` | no |
| `updatedAt` | `number` | yes |

### <a id="harness.getDefault"></a>`harness.getDefault` (rpc)

Subject: `harness.getDefault`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `clientId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `approvalPolicy` | `"reject" \| "always-ask" \| "full-access"` | yes |
| `capabilityOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `credentials` | `Record<string, string> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `name` | `string` | yes |
| `nativeTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `registryTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `skills` | `{ enabled: string[]; disabled: string[]; } \| undefined` | no |
| `toolApprovalOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `toolCapabilityMap` | `Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined` | no |
| `updatedAt` | `number` | yes |

### <a id="harness.getSchema"></a>`harness.getSchema` (rpc)

Subject: `harness.getSchema`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `schema` | `Record<string, unknown>` | yes |
| `uiConfig` | `{ editMode: "inline" \| "slidePanel" \| "fullPage"; hiddenFields?: string[] \| undefined; readOnlyInEditMode?: string[] \| undefined; fieldOverrides?: Record<string, { widget?: string \| undefined; delimiter?: string \| undefined; placeholder?: string \| undefined; helpText?: string \| undefined; min?: number \| undefined; max?: number \| undefined; step?: number \| undefined; options?: { value: string; label: string; }[] \| undefined; }> \| undefined; sections?: { id: string; title: string; fields: string[]; description?: string \| undefined; }[] \| undefined; }` | yes |

### <a id="harness.list"></a>`harness.list` (rpc)

Subject: `harness.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `name` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `harnesses` | `{ id: string; name: string; approvalPolicy: "reject" \| "always-ask" \| "full-access"; nativeTools: { enabled: string[]; disabled: string[]; }; registryTools: { enabled: string[]; disabled: string[]; }; isDefault: boolean; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; adapterName?: string \| undefined; clientId?: string \| undefined; skills?: { enabled: string[]; disabled: string[]; } \| undefined; toolCapabilityMap?: Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined; capabilityOverrides?: Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined; toolApprovalOverrides?: Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined; env?: Record<string, string> \| undefined; credentials?: Record<string, string> \| undefined; cwd?: string \| undefined; }[]` | yes |

### <a id="harness.resolve"></a>`harness.resolve` (rpc)

Subject: `harness.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `personaHarnessId` | `string \| undefined` | no |
| `profileHarnessId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `approvalPolicy` | `"reject" \| "always-ask" \| "full-access"` | yes |
| `capabilityOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `credentials` | `Record<string, string> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `name` | `string` | yes |
| `nativeTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `registryTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `skills` | `{ enabled: string[]; disabled: string[]; } \| undefined` | no |
| `toolApprovalOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `toolCapabilityMap` | `Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined` | no |
| `updatedAt` | `number` | yes |

### <a id="harness.set"></a>`harness.set` (rpc)

Subject: `harness.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `approvalPolicy` | `"reject" \| "always-ask" \| "full-access" \| undefined` | no |
| `capabilityOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `credentials` | `Record<string, string> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean \| undefined` | no |
| `env` | `Record<string, string> \| undefined` | no |
| `isDefault` | `boolean \| undefined` | no |
| `name` | `string` | yes |
| `nativeTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `registryTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `skills` | `{ enabled: string[]; disabled: string[]; } \| undefined` | no |
| `toolApprovalOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `toolCapabilityMap` | `Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="harness.updated"></a>`harness.updated` (event)

Emitted after an existing harness definition is updated.

Subject: `harness.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `approvalPolicy` | `"reject" \| "always-ask" \| "full-access"` | yes |
| `capabilityOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `createdAt` | `number` | yes |
| `credentials` | `Record<string, string> \| undefined` | no |
| `cwd` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `enabled` | `boolean` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `id` | `string` | yes |
| `isDefault` | `boolean` | yes |
| `name` | `string` | yes |
| `nativeTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `registryTools` | `{ enabled: string[]; disabled: string[]; }` | yes |
| `skills` | `{ enabled: string[]; disabled: string[]; } \| undefined` | no |
| `toolApprovalOverrides` | `Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined` | no |
| `toolCapabilityMap` | `Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined` | no |
| `updatedAt` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

---
title: "storage:client"
editUrl: false
prev: false
next: false
---

# `storage:client`

| Field | Value |
|-------|-------|
| Prefix | `storage:client` |
| Namespace constant | `ClientStorageNamespace` |
| Subjects constant | `ClientStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/settings/storage/clients-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/settings/storage/clients-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `get` | [`storage:client.get`](#storage:client.get) | rpc | — |
| `list` | [`storage:client.list`](#storage:client.list) | rpc | — |
| `listByBinaryName` | [`storage:client.listByBinaryName`](#storage:client.listByBinaryName) | rpc | — |

## Subject Details

### <a id="storage:client.get"></a>`storage:client.get` (rpc)

Subject: `storage:client.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `client` | `{ id: string; packageName: string; name: string; nativeTools: { name: string; friendlyName: string; capabilities: { tag: string; description?: string \| undefined; }[]; description?: string \| undefined; category?: string \| undefined; }[]; defaultApprovalPolicy: "reject" \| "always-ask" \| "full-access"; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "inferred"; label: string; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; binary?: { name: string; supportedVersions: string; } \| undefined; logSources?: { id: string; name: string; description?: string \| undefined; glob?: string \| undefined; }[] \| undefined; defaultAuth?: { providerDefinitionId: string; methodId: string; } \| undefined; env?: Record<string, string> \| undefined; cwd?: string \| undefined; } \| null` | yes |

### <a id="storage:client.list"></a>`storage:client.list` (rpc)

Subject: `storage:client.list`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clients` | `{ id: string; packageName: string; name: string; nativeTools: { name: string; friendlyName: string; capabilities: { tag: string; description?: string \| undefined; }[]; description?: string \| undefined; category?: string \| undefined; }[]; defaultApprovalPolicy: "reject" \| "always-ask" \| "full-access"; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "inferred"; label: string; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; binary?: { name: string; supportedVersions: string; } \| undefined; logSources?: { id: string; name: string; description?: string \| undefined; glob?: string \| undefined; }[] \| undefined; defaultAuth?: { providerDefinitionId: string; methodId: string; } \| undefined; env?: Record<string, string> \| undefined; cwd?: string \| undefined; }[]` | yes |

### <a id="storage:client.listByBinaryName"></a>`storage:client.listByBinaryName` (rpc)

Subject: `storage:client.listByBinaryName`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `binaryName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clients` | `{ id: string; packageName: string; name: string; nativeTools: { name: string; friendlyName: string; capabilities: { tag: string; description?: string \| undefined; }[]; description?: string \| undefined; category?: string \| undefined; }[]; defaultApprovalPolicy: "reject" \| "always-ask" \| "full-access"; authMethods: ({ id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; } \| { id: string; mode: "inferred"; label: string; description?: string \| undefined; } \| { id: string; mode: "none"; label: string; description?: string \| undefined; })[]; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; binary?: { name: string; supportedVersions: string; } \| undefined; logSources?: { id: string; name: string; description?: string \| undefined; glob?: string \| undefined; }[] \| undefined; defaultAuth?: { providerDefinitionId: string; methodId: string; } \| undefined; env?: Record<string, string> \| undefined; cwd?: string \| undefined; }[]` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

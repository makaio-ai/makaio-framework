---
title: "storage:harness"
editUrl: false
prev: false
next: false
---

# `storage:harness`

| Field | Value |
|-------|-------|
| Prefix | `storage:harness` |
| Namespace constant | `HarnessStorageNamespace` |
| Subjects constant | `HarnessStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/harness/storage/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/harness/storage/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `delete` | [`storage:harness.delete`](#storage:harness.delete) | rpc | — |
| `get` | [`storage:harness.get`](#storage:harness.get) | rpc | — |
| `list` | [`storage:harness.list`](#storage:harness.list) | rpc | — |
| `set` | [`storage:harness.set`](#storage:harness.set) | rpc | — |

## Subject Details

### <a id="storage:harness.delete"></a>`storage:harness.delete` (rpc)

Subject: `storage:harness.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="storage:harness.get"></a>`storage:harness.get` (rpc)

Subject: `storage:harness.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `harness` | `{ id: string; name: string; approvalPolicy: "reject" \| "always-ask" \| "full-access"; nativeTools: { enabled: string[]; disabled: string[]; }; registryTools: { enabled: string[]; disabled: string[]; }; isDefault: boolean; enabled: boolean; createdAt: number; updatedAt: number; description?: string \| undefined; adapterName?: string \| undefined; clientId?: string \| undefined; skills?: { enabled: string[]; disabled: string[]; } \| undefined; toolCapabilityMap?: Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined; capabilityOverrides?: Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined; toolApprovalOverrides?: Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined; env?: Record<string, string> \| undefined; credentials?: Record<string, string> \| undefined; cwd?: string \| undefined; } \| null` | yes |

### <a id="storage:harness.list"></a>`storage:harness.list` (rpc)

Subject: `storage:harness.list`
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

### <a id="storage:harness.set"></a>`storage:harness.set` (rpc)

Subject: `storage:harness.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `harness` | `{ name: string; id: string; approvalPolicy: "reject" \| "always-ask" \| "full-access"; isDefault: boolean; enabled: boolean; nativeTools: { enabled: string[]; disabled: string[]; }; registryTools: { enabled: string[]; disabled: string[]; }; adapterName?: string \| undefined; clientId?: string \| undefined; env?: Record<string, string> \| undefined; description?: string \| undefined; cwd?: string \| undefined; toolCapabilityMap?: Record<string, readonly ("file.read" \| "file.write" \| "file.delete" \| "search.content" \| "search.files" \| "search.web" \| "shell.execute" \| "network.request" \| "process.manage")[]> \| undefined; capabilityOverrides?: Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined; toolApprovalOverrides?: Record<string, "reject" \| "always-ask" \| "full-access"> \| undefined; credentials?: Record<string, string> \| undefined; skills?: { enabled: string[]; disabled: string[]; } \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

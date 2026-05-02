---
title: "storage:supervisor-runtime"
editUrl: false
prev: false
next: false
---

# `storage:supervisor-runtime`

| Field | Value |
|-------|-------|
| Prefix | `storage:supervisor-runtime` |
| Namespace constant | `SupervisorRuntimeStorageNamespace` |
| Subjects constant | `SupervisorRuntimeStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/native-session-supervisor` |
| Defined in | [`packages/native-session-supervisor/src/storage/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/native-session-supervisor/src/storage/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `delete` | [`storage:supervisor-runtime.delete`](#storage:supervisor-runtime.delete) | rpc | — |
| `get` | [`storage:supervisor-runtime.get`](#storage:supervisor-runtime.get) | rpc | — |
| `list` | [`storage:supervisor-runtime.list`](#storage:supervisor-runtime.list) | rpc | — |
| `set` | [`storage:supervisor-runtime.set`](#storage:supervisor-runtime.set) | rpc | — |
| `update` | [`storage:supervisor-runtime.update`](#storage:supervisor-runtime.update) | rpc | — |

## Subject Details

### <a id="storage:supervisor-runtime.delete"></a>`storage:supervisor-runtime.delete` (rpc)

Delete a supervisor runtime record by its canonical ID.

Subject: `storage:supervisor-runtime.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `supervisorSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:supervisor-runtime.get"></a>`storage:supervisor-runtime.get` (rpc)

Get a single supervisor runtime by any correlation key.

Exactly one of the locator fields must be provided.

Subject: `storage:supervisor-runtime.get`
Type: Request (RPC)

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `runtime` | `{ supervisorSessionId: string; clientId: string; pid: number \| null; status: "unknown" \| "running" \| "stopped" \| "exited"; cwd: string; command: string; args: string[]; startedAt: number; env?: Record<string, string> \| undefined; sessionId?: string \| undefined; adapterSessionId?: string \| undefined; stoppedAt?: number \| undefined; metadata?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="storage:supervisor-runtime.list"></a>`storage:supervisor-runtime.list` (rpc)

List supervisor runtimes with optional status filter.

Returns full runtime records (not just snapshots) to allow the registry
to fully hydrate its in-memory cache from a single storage query.

Subject: `storage:supervisor-runtime.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limit` | `number \| undefined` | no |
| `status` | `"unknown" \| "running" \| "stopped" \| "exited" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `runtimes` | `{ supervisorSessionId: string; clientId: string; pid: number \| null; status: "unknown" \| "running" \| "stopped" \| "exited"; cwd: string; command: string; args: string[]; startedAt: number; env?: Record<string, string> \| undefined; sessionId?: string \| undefined; adapterSessionId?: string \| undefined; stoppedAt?: number \| undefined; metadata?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="storage:supervisor-runtime.set"></a>`storage:supervisor-runtime.set` (rpc)

Insert or fully replace a supervisor runtime record.

Subject: `storage:supervisor-runtime.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `args` | `string[]` | yes |
| `clientId` | `string` | yes |
| `command` | `string` | yes |
| `cwd` | `string` | yes |
| `env` | `Record<string, string> \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `pid` | `number \| null` | yes |
| `sessionId` | `string \| undefined` | no |
| `startedAt` | `number` | yes |
| `status` | `"unknown" \| "running" \| "stopped" \| "exited"` | yes |
| `stoppedAt` | `number \| undefined` | no |
| `supervisorSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:supervisor-runtime.update"></a>`storage:supervisor-runtime.update` (rpc)

Apply a partial update to an existing supervisor runtime.

Subject: `storage:supervisor-runtime.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `pid` | `number \| null \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `status` | `"unknown" \| "running" \| "stopped" \| "exited" \| undefined` | no |
| `stoppedAt` | `number \| undefined` | no |
| `supervisorSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

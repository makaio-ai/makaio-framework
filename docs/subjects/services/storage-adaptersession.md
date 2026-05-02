---
title: "storage:adapterSession"
editUrl: false
prev: false
next: false
---

# `storage:adapterSession`

| Field | Value |
|-------|-------|
| Prefix | `storage:adapterSession` |
| Namespace constant | `AdapterSessionStorageNamespace` |
| Subjects constant | `AdapterSessionStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`packages/services/core/src/session/adapter-sessions/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/services/core/src/session/adapter-sessions/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `countByAdapter` | [`storage:adapterSession.countByAdapter`](#storage:adapterSession.countByAdapter) | rpc | — |
| `createAndLink` | [`storage:adapterSession.createAndLink`](#storage:adapterSession.createAndLink) | rpc | — |
| `get` | [`storage:adapterSession.get`](#storage:adapterSession.get) | rpc | — |
| `getByLogFilePath` | [`storage:adapterSession.getByLogFilePath`](#storage:adapterSession.getByLogFilePath) | rpc | — |
| `linkSession` | [`storage:adapterSession.linkSession`](#storage:adapterSession.linkSession) | rpc | — |
| `list` | [`storage:adapterSession.list`](#storage:adapterSession.list) | rpc | — |
| `updateStatus` | [`storage:adapterSession.updateStatus`](#storage:adapterSession.updateStatus) | rpc | — |
| `upsert` | [`storage:adapterSession.upsert`](#storage:adapterSession.upsert) | rpc | — |

## Subject Details

### <a id="storage:adapterSession.countByAdapter"></a>`storage:adapterSession.countByAdapter` (rpc)

Count adapter sessions grouped by status.

Subject: `storage:adapterSession.countByAdapter`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `discovered` | `number` | yes |
| `imported` | `number` | yes |
| `total` | `number` | yes |

### <a id="storage:adapterSession.createAndLink"></a>`storage:adapterSession.createAndLink` (rpc)

Create and link a Makaio session for an adapter session.

Consolidates session creation, parent/scope resolution, linking,
and event emission into a single idempotent bus request.
The bus field is injected by the handler — callers must not pass it.

Subject: `storage:adapterSession.createAndLink`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `existingSessionId` | `string \| undefined` | no |
| `metadata` | `({ kind: "fork"; parentAdapterSessionId: string; forkPointMessageId: string; } \| { kind: "subagent"; parentAdapterSessionId: string; forkPointMessageId: null; } \| { kind: "compress"; parentAdapterSessionId: string; forkPointMessageId: null; } \| { parentAdapterSessionId: null; forkPointMessageId: null; kind: null; }) & { model: string \| null; cwd: string \| null; title: string \| null; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `created` | `boolean` | yes |
| `sessionId` | `string` | yes |

### <a id="storage:adapterSession.get"></a>`storage:adapterSession.get` (rpc)

Get an adapter session by ID.

Subject: `storage:adapterSession.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ adapterSessionId: string; adapterName: string; parentAdapterSessionId: string \| null; forkPointMessageId: string \| null; sessionId: string \| null; model: string \| null; cwd: string \| null; logFilePath: string \| null; discoveredAt: number; startedAt: number; status: "discovered" \| "imported" \| "live" \| "tracking"; kind: "fork" \| "root" \| "subagent" \| "compress"; } \| null` | yes |

### <a id="storage:adapterSession.getByLogFilePath"></a>`storage:adapterSession.getByLogFilePath` (rpc)

Get an adapter session by its source log file path.

Subject: `storage:adapterSession.getByLogFilePath`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `logFilePath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ adapterSessionId: string; adapterName: string; parentAdapterSessionId: string \| null; forkPointMessageId: string \| null; sessionId: string \| null; model: string \| null; cwd: string \| null; logFilePath: string \| null; discoveredAt: number; startedAt: number; status: "discovered" \| "imported" \| "live" \| "tracking"; kind: "fork" \| "root" \| "subagent" \| "compress"; } \| null` | yes |

### <a id="storage:adapterSession.linkSession"></a>`storage:adapterSession.linkSession` (rpc)

Link an adapter session to a Makaio session.

Subject: `storage:adapterSession.linkSession`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:adapterSession.list"></a>`storage:adapterSession.list` (rpc)

List all adapter sessions.

Returns all adapter session records ordered by startedAt descending.
Used by the entity cache to populate the reactive `adapterSessions` collection.

Subject: `storage:adapterSession.list`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessions` | `{ adapterSessionId: string; adapterName: string; parentAdapterSessionId: string \| null; forkPointMessageId: string \| null; sessionId: string \| null; model: string \| null; cwd: string \| null; logFilePath: string \| null; discoveredAt: number; startedAt: number; status: "discovered" \| "imported" \| "live" \| "tracking"; kind: "fork" \| "root" \| "subagent" \| "compress"; }[]` | yes |

### <a id="storage:adapterSession.updateStatus"></a>`storage:adapterSession.updateStatus` (rpc)

Update adapter session status.

Subject: `storage:adapterSession.updateStatus`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |
| `status` | `"discovered" \| "imported" \| "live" \| "tracking"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:adapterSession.upsert"></a>`storage:adapterSession.upsert` (rpc)

Upsert an adapter session record.

If the record exists, updates mutable fields (parent, forkPoint, model, cwd).
If not, inserts with discoveredAt=Date.now() and status='discovered'.

Subject: `storage:adapterSession.upsert`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `cwd` | `string \| null` | yes |
| `forkPointMessageId` | `string \| null` | yes |
| `kind` | `"fork" \| "root" \| "subagent" \| "compress"` | yes |
| `logFilePath` | `string \| null \| undefined` | no |
| `model` | `string \| null` | yes |
| `parentAdapterSessionId` | `string \| null` | yes |
| `startedAt` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |
| `created` | `boolean` | yes |
| `sessionId` | `string \| null` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

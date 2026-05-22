---
title: "storage:turn"
editUrl: false
prev: false
next: false
---

# `storage:turn`

| Field | Value |
|-------|-------|
| Prefix | `storage:turn` |
| Namespace constant | `TurnStorageNamespace` |
| Subjects constant | `TurnStorageSubjects` |
| Kind | storage |
| Schema record | `TurnStorageSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/turn/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `complete` | [`storage:turn.complete`](#storage:turn.complete) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |
| `create` | [`storage:turn.create`](#storage:turn.create) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |
| `get` | [`storage:turn.get`](#storage:turn.get) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |
| `getActive` | [`storage:turn.getActive`](#storage:turn.getActive) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |
| `getBySession` | [`storage:turn.getBySession`](#storage:turn.getBySession) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |
| `listActive` | [`storage:turn.listActive`](#storage:turn.listActive) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |
| `set` | [`storage:turn.set`](#storage:turn.set) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/turn/schemas.ts) |

## Subject Details

### <a id="storage:turn.complete"></a>`storage:turn.complete` (rpc)

Complete a turn (mark as completed or error).

Subject: `storage:turn.complete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `expectedStatus` | `"error" \| "active" \| "completed" \| undefined` | no |
| `status` | `"error" \| "completed"` | yes |
| `turnId` | `string` | yes |
| `usage` | `{ total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `transitioned` | `boolean` | yes |
| `turn` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }` | yes |

### <a id="storage:turn.create"></a>`storage:turn.create` (rpc)

Create a new turn.

Subject: `storage:turn.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `turn` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }` | yes |

### <a id="storage:turn.get"></a>`storage:turn.get` (rpc)

Get a turn by ID.

Subject: `storage:turn.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `turnId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `turn` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; } \| null` | yes |

### <a id="storage:turn.getActive"></a>`storage:turn.getActive` (rpc)

Get the active turn for a session (if any).

Subject: `storage:turn.getActive`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `turn` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; } \| null` | yes |

### <a id="storage:turn.getBySession"></a>`storage:turn.getBySession` (rpc)

List turns for a session.

Subject: `storage:turn.getBySession`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limit` | `number \| undefined` | no |
| `sessionId` | `string` | yes |
| `status` | `"error" \| "active" \| "completed" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `turns` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }[]` | yes |

### <a id="storage:turn.listActive"></a>`storage:turn.listActive` (rpc)

List all active turns across all sessions.

Used at startup to identify orphaned turns left active after a process crash.
No session filter — returns every turn with status `'active'`.

Subject: `storage:turn.listActive`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `turns` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }[]` | yes |

### <a id="storage:turn.set"></a>`storage:turn.set` (rpc)

Store or update a turn with full data.

Subject: `storage:turn.set`
Type: Request (RPC)

Used for imports and backfills that need to preserve timestamps/usage.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `turn` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `turn` | `{ turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

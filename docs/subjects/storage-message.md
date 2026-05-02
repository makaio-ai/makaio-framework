---
title: "storage:message"
editUrl: false
prev: false
next: false
---

# `storage:message`

| Field | Value |
|-------|-------|
| Prefix | `storage:message` |
| Namespace constant | `MessageStorageNamespace` |
| Subjects constant | `MessageStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/session/message-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/session/message-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `append` | [`storage:message.append`](#storage:message.append) | rpc | — |
| `ftsSearch` | [`storage:message.ftsSearch`](#storage:message.ftsSearch) | rpc | — |
| `get` | [`storage:message.get`](#storage:message.get) | rpc | — |
| `getByAdapterMessageId` | [`storage:message.getByAdapterMessageId`](#storage:message.getByAdapterMessageId) | rpc | — |
| `getBySession` | [`storage:message.getBySession`](#storage:message.getBySession) | rpc | — |
| `getByTurn` | [`storage:message.getByTurn`](#storage:message.getByTurn) | rpc | — |
| `search` | [`storage:message.search`](#storage:message.search) | rpc | — |
| `stored` | [`storage:message.stored`](#storage:message.stored) | event | — |
| `upsertByAdapterMessageId` | [`storage:message.upsertByAdapterMessageId`](#storage:message.upsertByAdapterMessageId) | rpc | — |

## Subject Details

### <a id="storage:message.append"></a>`storage:message.append` (rpc)

Append a message to a turn.

Subject: `storage:message.append`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `emitEvent` | `boolean \| undefined` | no |
| `message` | `{ role: "user" \| "assistant"; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; sessionId: string; timestamp: number; turnId: string \| null; contentText: string; origin?: "text" \| "voice" \| "compact" \| undefined; adapterSessionId?: string \| undefined; agentId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; messageId?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `message` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }` | yes |

### <a id="storage:message.ftsSearch"></a>`storage:message.ftsSearch` (rpc)

Full-text search over messages using FTS5 with BM25 scores and excerpts.

Subject: `storage:message.ftsSearch`
Type: Request (RPC)

Unlike `search`, this subject returns scored results with highlighted
excerpts — suitable for ranking and display in search UIs.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limit` | `number` | yes |
| `query` | `string` | yes |
| `sessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `results` | `{ messageId: string; sessionId: string; score: number; excerpt: string; }[]` | yes |
| `total` | `number` | yes |

### <a id="storage:message.get"></a>`storage:message.get` (rpc)

Get a single message by ID.

Subject: `storage:message.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `messageId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `message` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; } \| null` | yes |

### <a id="storage:message.getByAdapterMessageId"></a>`storage:message.getByAdapterMessageId` (rpc)

Get a message by adapter message ID.

Subject: `storage:message.getByAdapterMessageId`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterMessageId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `message` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; } \| null` | yes |

### <a id="storage:message.getBySession"></a>`storage:message.getBySession` (rpc)

Get messages for a session.

Subject: `storage:message.getBySession`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `after` | `{ timestamp: number; messageId: string; } \| undefined` | no |
| `includeAfter` | `boolean \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `order` | `"asc" \| "desc" \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messages` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }[]` | yes |
| `nextCursor` | `{ timestamp: number; messageId: string; } \| null` | yes |

### <a id="storage:message.getByTurn"></a>`storage:message.getByTurn` (rpc)

Get messages for a turn.

Subject: `storage:message.getByTurn`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `turnId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messages` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }[]` | yes |

### <a id="storage:message.search"></a>`storage:message.search` (rpc)

Search messages using FTS5.

Subject: `storage:message.search`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limit` | `number \| undefined` | no |
| `query` | `string` | yes |
| `sessionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messages` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="storage:message.stored"></a>`storage:message.stored` (event)

Emitted after a message is successfully persisted.

Subject: `storage:message.stored`
Type: Event (fire-and-forget via bus.emit)

| Field | Type | Required |
|-------|------|----------|
| `message` | `{ messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }` | yes |

### <a id="storage:message.upsertByAdapterMessageId"></a>`storage:message.upsertByAdapterMessageId` (rpc)

Upsert a message by adapterMessageId (for imports).

Subject: `storage:message.upsertByAdapterMessageId`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterMessageId` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string \| undefined` | no |
| `blocks` | `({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]` | yes |
| `contentText` | `string` | yes |
| `origin` | `"text" \| "voice" \| "compact" \| undefined` | no |
| `role` | `"user" \| "assistant"` | yes |
| `sessionId` | `string` | yes |
| `timestamp` | `number` | yes |
| `turnId` | `string \| null` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `created` | `boolean` | yes |
| `messageId` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

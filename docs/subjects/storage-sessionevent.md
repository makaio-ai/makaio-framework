---
title: "storage:sessionEvent"
editUrl: false
prev: false
next: false
---

# `storage:sessionEvent`

| Field | Value |
|-------|-------|
| Prefix | `storage:sessionEvent` |
| Namespace constant | `SessionEventStorageNamespace` |
| Subjects constant | `SessionEventStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/session/session-event-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/session/session-event-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `append` | [`storage:sessionEvent.append`](#storage:sessionEvent.append) | rpc | — |
| `deleteBySession` | [`storage:sessionEvent.deleteBySession`](#storage:sessionEvent.deleteBySession) | rpc | — |
| `getByIds` | [`storage:sessionEvent.getByIds`](#storage:sessionEvent.getByIds) | rpc | — |
| `getEvents` | [`storage:sessionEvent.getEvents`](#storage:sessionEvent.getEvents) | rpc | — |
| `getEventsBySessions` | [`storage:sessionEvent.getEventsBySessions`](#storage:sessionEvent.getEventsBySessions) | rpc | — |

## Subject Details

### <a id="storage:sessionEvent.append"></a>`storage:sessionEvent.append` (rpc)

Append an event to storage.

Subject: `storage:sessionEvent.append`
Type: Request (RPC)

Events are immutable — no update method exists.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `event` | `{ sessionId: string; eventId: string; timestamp: number; type: "agent.added"; payload: { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.sent"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.acknowledged"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.started"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "message"; payload: { messageId: string; turnId: string \| null; role: "user" \| "assistant"; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.created"; payload: { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.merged"; payload: { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "squash"; payload: { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: string; payload: Record<string, unknown>; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:sessionEvent.deleteBySession"></a>`storage:sessionEvent.deleteBySession` (rpc)

Delete all events for a session.

Subject: `storage:sessionEvent.deleteBySession`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deletedCount` | `number \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="storage:sessionEvent.getByIds"></a>`storage:sessionEvent.getByIds` (rpc)

Get events by ID for a session.

Subject: `storage:sessionEvent.getByIds`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `eventIds` | `string[]` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `events` | `({ sessionId: string; eventId: string; timestamp: number; type: "agent.added"; payload: { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.sent"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.acknowledged"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.started"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "message"; payload: { messageId: string; turnId: string \| null; role: "user" \| "assistant"; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.created"; payload: { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.merged"; payload: { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "squash"; payload: { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: string; payload: Record<string, unknown>; })[]` | yes |

### <a id="storage:sessionEvent.getEvents"></a>`storage:sessionEvent.getEvents` (rpc)

Get events for a session with cursor-based pagination.

Subject: `storage:sessionEvent.getEvents`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `options` | `{ after?: string \| undefined; limit?: number \| undefined; types?: string[] \| undefined; includeReasoning?: boolean \| undefined; order?: "asc" \| "desc" \| undefined; } \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `events` | `({ sessionId: string; eventId: string; timestamp: number; type: "agent.added"; payload: { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.sent"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.acknowledged"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.started"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "message"; payload: { messageId: string; turnId: string \| null; role: "user" \| "assistant"; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.created"; payload: { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.merged"; payload: { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "squash"; payload: { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: string; payload: Record<string, unknown>; })[]` | yes |
| `nextCursor` | `string \| null` | yes |
| `totalCount` | `number \| undefined` | no |

### <a id="storage:sessionEvent.getEventsBySessions"></a>`storage:sessionEvent.getEventsBySessions` (rpc)

Get events for multiple sessions, grouped by session ID.

Subject: `storage:sessionEvent.getEventsBySessions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limitPerSession` | `number \| undefined` | no |
| `sessionIds` | `string[]` | yes |
| `types` | `string[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `eventsBySession` | `Record<string, ({ sessionId: string; eventId: string; timestamp: number; type: "agent.added"; payload: { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.sent"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.acknowledged"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.started"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "message"; payload: { messageId: string; turnId: string \| null; role: "user" \| "assistant"; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.created"; payload: { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.merged"; payload: { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "squash"; payload: { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: string; payload: Record<string, unknown>; })[]>` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

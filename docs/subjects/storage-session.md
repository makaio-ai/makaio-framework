---
title: "storage:session"
editUrl: false
prev: false
next: false
---

# `storage:session`

| Field | Value |
|-------|-------|
| Prefix | `storage:session` |
| Namespace constant | `SessionStorageNamespace` |
| Subjects constant | `SessionStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/session/session-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/session/session-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `delete` | [`storage:session.delete`](#storage:session.delete) | rpc | — |
| `get` | [`storage:session.get`](#storage:session.get) | rpc | — |
| `getByAdapterSessionId` | [`storage:session.getByAdapterSessionId`](#storage:session.getByAdapterSessionId) | rpc | — |
| `getChildren` | [`storage:session.getChildren`](#storage:session.getChildren) | rpc | — |
| `getStatusCounts` | [`storage:session.getStatusCounts`](#storage:session.getStatusCounts) | rpc | — |
| `list` | [`storage:session.list`](#storage:session.list) | rpc | — |
| `search` | [`storage:session.search`](#storage:session.search) | rpc | — |
| `set` | [`storage:session.set`](#storage:session.set) | rpc | — |
| `update` | [`storage:session.update`](#storage:session.update) | rpc | — |

## Subject Details

### <a id="storage:session.delete"></a>`storage:session.delete` (rpc)

Delete a session by ID.

Subject: `storage:session.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:session.get"></a>`storage:session.get` (rpc)

Get a session by ID.

Subject: `storage:session.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "auto" \| "manual" \| "off" \| undefined; }[]; status: "discovered" \| "active" \| "closed" \| "archived"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; } \| null` | yes |

### <a id="storage:session.getByAdapterSessionId"></a>`storage:session.getByAdapterSessionId` (rpc)

Get a session by its adapter session ID.

Subject: `storage:session.getByAdapterSessionId`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "auto" \| "manual" \| "off" \| undefined; }[]; status: "discovered" \| "active" \| "closed" \| "archived"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; } \| null` | yes |

### <a id="storage:session.getChildren"></a>`storage:session.getChildren` (rpc)

List direct child sessions for a parent session.

Subject: `storage:session.getChildren`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `children` | `{ sessionId: string; title: string \| null; forkPointMessageId: string \| null; branchKind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| null; messageCount: number; hasChildren: boolean; spawningToolCallId?: string \| undefined; }[]` | yes |

### <a id="storage:session.getStatusCounts"></a>`storage:session.getStatusCounts` (rpc)

Get session counts by status.

Subject: `storage:session.getStatusCounts`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `active` | `number` | yes |
| `all` | `number` | yes |
| `archived` | `number` | yes |
| `closed` | `number` | yes |
| `discovered` | `number` | yes |

### <a id="storage:session.list"></a>`storage:session.list` (rpc)

List sessions with optional status filter and preview data.

Subject: `storage:session.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionTargetId` | `string \| undefined` | no |
| `includePreview` | `boolean \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `offset` | `number \| undefined` | no |
| `status` | `"discovered" \| "active" \| "closed" \| "archived" \| "all" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "auto" \| "manual" \| "off" \| undefined; }[]; status: "discovered" \| "active" \| "closed" \| "archived"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; preview?: { messageCount: number; firstUserMessage: string \| null; } \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="storage:session.search"></a>`storage:session.search` (rpc)

Search sessions by content using FTS5.

Subject: `storage:session.search`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `isImported` | `boolean \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `query` | `string` | yes |
| `status` | `"discovered" \| "active" \| "closed" \| "archived" \| "all" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "auto" \| "manual" \| "off" \| undefined; }[]; status: "discovered" \| "active" \| "closed" \| "archived"; preview: { messageCount: number; firstUserMessage: string \| null; }; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="storage:session.set"></a>`storage:session.set` (rpc)

Store or update a session.

Subject: `storage:session.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ifAbsent` | `boolean \| undefined` | no |
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "auto" \| "manual" \| "off" \| undefined; }[]; status: "discovered" \| "active" \| "closed" \| "archived"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; }` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clientAccountChanged` | `boolean \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="storage:session.update"></a>`storage:session.update` (rpc)

Update specific fields of a session (partial update).

Subject: `storage:session.update`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `approvalPolicyOverride` | `"reject" \| "always-ask" \| "full-access" \| null \| undefined` | no |
| `branchKind` | `"fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined` | no |
| `clientAccountId` | `string \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `createdAt` | `number \| undefined` | no |
| `executionTargetId` | `string \| null \| undefined` | no |
| `forkPointMessageId` | `string \| undefined` | no |
| `isOrchestrated` | `boolean \| undefined` | no |
| `lastActivityAt` | `number \| undefined` | no |
| `lastClientIdentityObservation` | `{ clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined` | no |
| `parentSessionId` | `string \| undefined` | no |
| `rootSessionId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |
| `spawningToolCallId` | `string \| null \| undefined` | no |
| `status` | `"discovered" \| "active" \| "closed" \| "archived" \| undefined` | no |
| `targetWorkingDirectory` | `string \| undefined` | no |
| `title` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clientAccountChanged` | `boolean \| undefined` | no |
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

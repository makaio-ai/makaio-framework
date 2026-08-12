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
| Defined in | [`core/contracts/src/session/session-storage-namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/session-storage-namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `countBySource` | [`storage:session.countBySource`](#storage:session.countBySource) | rpc | — |
| `delete` | [`storage:session.delete`](#storage:session.delete) | rpc | — |
| `get` | [`storage:session.get`](#storage:session.get) | rpc | — |
| `getByAdapterSessionId` | [`storage:session.getByAdapterSessionId`](#storage:session.getByAdapterSessionId) | rpc | — |
| `getByLogFilePath` | [`storage:session.getByLogFilePath`](#storage:session.getByLogFilePath) | rpc | — |
| `getChildren` | [`storage:session.getChildren`](#storage:session.getChildren) | rpc | — |
| `getStatusCounts` | [`storage:session.getStatusCounts`](#storage:session.getStatusCounts) | rpc | — |
| `importUpsert` | [`storage:session.importUpsert`](#storage:session.importUpsert) | rpc | — |
| `list` | [`storage:session.list`](#storage:session.list) | rpc | — |
| `listImported` | [`storage:session.listImported`](#storage:session.listImported) | rpc | — |
| `rebindObserved` | [`storage:session.rebindObserved`](#storage:session.rebindObserved) | rpc | — |
| `search` | [`storage:session.search`](#storage:session.search) | rpc | — |
| `set` | [`storage:session.set`](#storage:session.set) | rpc | — |
| `update` | [`storage:session.update`](#storage:session.update) | rpc | — |
| `updateImportStatus` | [`storage:session.updateImportStatus`](#storage:session.updateImportStatus) | rpc | — |

## Subject Details

### <a id="storage:session.countBySource"></a>`storage:session.countBySource` (rpc)

Count imported sessions grouped by importStatus for a given source.
Used by the UI dashboard to display import progress.

Subject: `storage:session.countBySource`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `source` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `discovered` | `number` | yes |
| `imported` | `number` | yes |
| `total` | `number` | yes |
| `tracking` | `number` | yes |

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
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; } \| null` | yes |

### <a id="storage:session.getByAdapterSessionId"></a>`storage:session.getByAdapterSessionId` (rpc)

Get a session by its adapter session ID.

Subject: `storage:session.getByAdapterSessionId`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string \| undefined` | no |
| `adapterSessionId` | `string` | yes |
| `source` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; } \| null` | yes |

### <a id="storage:session.getByLogFilePath"></a>`storage:session.getByLogFilePath` (rpc)

Get a session by its source log file path.
Used by the discovery orchestrator for cursor resumption.

Subject: `storage:session.getByLogFilePath`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `logFilePath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; } \| null` | yes |

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

### <a id="storage:session.importUpsert"></a>`storage:session.importUpsert` (rpc)

Creates or updates an imported session record. On first import, creates a new
session with `status='discovered'` by default, or `status='active'` when live
activation is requested. On subsequent calls, enriches existing records with
COALESCE semantics so later scans can supply previously-unknown values without
overwriting already-populated ones.

Subject: `storage:session.importUpsert`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `activation` | `"live" \| undefined` | no |
| `adapterId` | `string \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `cwd` | `string \| null` | yes |
| `externalSessionId` | `string` | yes |
| `forkPointMessageId` | `null \| string` | yes |
| `importStatus` | `"discovered" \| "tracking" \| undefined` | no |
| `isSidechain` | `boolean \| undefined` | no |
| `kind` | `"root" \| "fork" \| "subagent" \| "compress"` | yes |
| `lastClientIdentityObservation` | `{ clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined` | no |
| `logFilePath` | `string \| null \| undefined` | no |
| `machineId` | `string \| null \| undefined` | no |
| `metadata` | `Record<string, JsonValue> \| undefined` | no |
| `parentAdapterSessionId` | `null \| string` | yes |
| `source` | `string` | yes |
| `startedAt` | `number \| undefined` | no |
| `title` | `string \| null \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `created` | `boolean` | yes |
| `sessionId` | `string` | yes |

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
| `status` | `"all" \| "active" \| "archived" \| "closed" \| "discovered" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; preview?: { messageCount: number; firstUserMessage: string \| null; } \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="storage:session.listImported"></a>`storage:session.listImported` (rpc)

List imported sessions with optional source filter.

Subject: `storage:session.listImported`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `importStatus` | `"discovered" \| "imported" \| "tracking" \| undefined` | no |
| `source` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; }[]` | yes |

### <a id="storage:session.rebindObserved"></a>`storage:session.rebindObserved` (rpc)

Rebind an already known observed session to the runtime that just
continued it (resume/compact).

Refreshes runtime/locality columns only and reports a miss instead of
creating a row — see `SessionStorageRebindObservedRequestSchema`.

Subject: `storage:session.rebindObserved`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `cwd` | `string \| undefined` | no |
| `externalSessionId` | `string` | yes |
| `logFilePath` | `string \| undefined` | no |
| `machineId` | `string \| null \| undefined` | no |
| `source` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `outcome` | `"rebound" \| "not-found"` | yes |
| `sessionId` | `string \| undefined` | no |

### <a id="storage:session.search"></a>`storage:session.search` (rpc)

Search sessions by message content (full-text: FTS5 on SQLite,
tsvector on Postgres) and session title (LIKE on both dialects).

Subject: `storage:session.search`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `isImported` | `boolean \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `query` | `string` | yes |
| `status` | `"all" \| "active" \| "archived" \| "closed" \| "discovered" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; preview: { messageCount: number; firstUserMessage: string \| null; }; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="storage:session.set"></a>`storage:session.set` (rpc)

Store or update a session.

Subject: `storage:session.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ifAbsent` | `boolean \| undefined` | no |
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "starting" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; runtimeOwner?: { machineId: string; instanceId: string; } \| undefined; recoveryAttemptId?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; revision?: number \| undefined; currencyFence?: number \| undefined; model?: string \| undefined; cwd?: string \| undefined; allowedDirectories?: string[] \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; currentAdapterSessionId?: string \| undefined; currentAdapterSessionIdState?: "confirmed" \| "inherited" \| "moved" \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; metadata?: Record<string, JsonValue> \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; isSidechain?: boolean \| undefined; machineId?: string \| null \| undefined; }` | yes |
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
| `contextInheritance` | `"none" \| "parent-history" \| undefined` | no |
| `createdAt` | `number \| undefined` | no |
| `executionTargetId` | `string \| null \| undefined` | no |
| `expectedStatus` | `("active" \| "archived" \| "closed" \| "discovered")[] \| undefined` | no |
| `expectIdentityOpenForLead` | `string \| null \| undefined` | no |
| `forkPointMessageId` | `string \| undefined` | no |
| `identity` | `{ adapterName: string; adapterId: string; adapterSessionId?: string \| undefined; } \| undefined` | no |
| `isOrchestrated` | `boolean \| undefined` | no |
| `lastActivityAt` | `number \| undefined` | no |
| `lastClientIdentityObservation` | `{ clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined` | no |
| `machineId` | `string \| null \| undefined` | no |
| `metadata` | `Record<string, JsonValue> \| null \| undefined` | no |
| `parentSessionId` | `string \| null \| undefined` | no |
| `reconcileAdapterSession` | `{ agentId: string; adapterName: string; adapterId: string; adapterSessionId: string; lastActivityAt: number; } \| undefined` | no |
| `rootSessionId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |
| `spawningToolCallId` | `string \| null \| undefined` | no |
| `status` | `"active" \| "archived" \| "closed" \| "discovered" \| undefined` | no |
| `targetWorkingDirectory` | `string \| undefined` | no |
| `title` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `clientAccountChanged` | `boolean \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="storage:session.updateImportStatus"></a>`storage:session.updateImportStatus` (rpc)

Update the import-specific status of a session.
Emits a lifecycle event on successful transition for entity cache reactivity.

Subject: `storage:session.updateImportStatus`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `importStatus` | `"discovered" \| "imported" \| "tracking"` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

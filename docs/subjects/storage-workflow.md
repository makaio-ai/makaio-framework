---
title: "storage:workflow"
editUrl: false
prev: false
next: false
---

# `storage:workflow`

| Field | Value |
|-------|-------|
| Prefix | `storage:workflow` |
| Namespace constant | `WorkflowStorageNamespace` |
| Subjects constant | `WorkflowStorageSubjects` |
| Kind | storage |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/subsystem-workflow-engine` |
| Defined in | [`subsystems/workflow-engine/src/storage/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/subsystems/workflow-engine/src/storage/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `acknowledgeFinalization` | [`storage:workflow.acknowledgeFinalization`](#storage:workflow.acknowledgeFinalization) | rpc | — |
| `claimFinalization` | [`storage:workflow.claimFinalization`](#storage:workflow.claimFinalization) | rpc | — |
| `delete` | [`storage:workflow.delete`](#storage:workflow.delete) | rpc | — |
| `failFinalization` | [`storage:workflow.failFinalization`](#storage:workflow.failFinalization) | rpc | — |
| `get` | [`storage:workflow.get`](#storage:workflow.get) | rpc | — |
| `getExecution` | [`storage:workflow.getExecution`](#storage:workflow.getExecution) | rpc | — |
| `getFrame` | [`storage:workflow.getFrame`](#storage:workflow.getFrame) | rpc | — |
| `getRunContext` | [`storage:workflow.getRunContext`](#storage:workflow.getRunContext) | rpc | — |
| `getState` | [`storage:workflow.getState`](#storage:workflow.getState) | rpc | — |
| `initializeState` | [`storage:workflow.initializeState`](#storage:workflow.initializeState) | rpc | — |
| `list` | [`storage:workflow.list`](#storage:workflow.list) | rpc | — |
| `listClaimedFinalizations` | [`storage:workflow.listClaimedFinalizations`](#storage:workflow.listClaimedFinalizations) | rpc | — |
| `listExecutionLinks` | [`storage:workflow.listExecutionLinks`](#storage:workflow.listExecutionLinks) | rpc | — |
| `listExecutions` | [`storage:workflow.listExecutions`](#storage:workflow.listExecutions) | rpc | — |
| `listExecutionsByArtifactRefs` | [`storage:workflow.listExecutionsByArtifactRefs`](#storage:workflow.listExecutionsByArtifactRefs) | rpc | — |
| `listFrames` | [`storage:workflow.listFrames`](#storage:workflow.listFrames) | rpc | — |
| `listSpans` | [`storage:workflow.listSpans`](#storage:workflow.listSpans) | rpc | — |
| `listUnpublishedFinalizations` | [`storage:workflow.listUnpublishedFinalizations`](#storage:workflow.listUnpublishedFinalizations) | rpc | — |
| `patchState` | [`storage:workflow.patchState`](#storage:workflow.patchState) | rpc | — |
| `publishFinalization` | [`storage:workflow.publishFinalization`](#storage:workflow.publishFinalization) | rpc | — |
| `set` | [`storage:workflow.set`](#storage:workflow.set) | rpc | — |
| `setExecution` | [`storage:workflow.setExecution`](#storage:workflow.setExecution) | rpc | — |
| `setExecutionLink` | [`storage:workflow.setExecutionLink`](#storage:workflow.setExecutionLink) | rpc | — |
| `setExecutionStart` | [`storage:workflow.setExecutionStart`](#storage:workflow.setExecutionStart) | rpc | — |
| `setExternalExecutionStart` | [`storage:workflow.setExternalExecutionStart`](#storage:workflow.setExternalExecutionStart) | rpc | — |
| `setFrame` | [`storage:workflow.setFrame`](#storage:workflow.setFrame) | rpc | — |
| `setRunContext` | [`storage:workflow.setRunContext`](#storage:workflow.setRunContext) | rpc | — |
| `setSpan` | [`storage:workflow.setSpan`](#storage:workflow.setSpan) | rpc | — |
| `settleExternalExecution` | [`storage:workflow.settleExternalExecution`](#storage:workflow.settleExternalExecution) | rpc | — |
| `updateExecution` | [`storage:workflow.updateExecution`](#storage:workflow.updateExecution) | rpc | — |

## Subject Details

### <a id="storage:workflow.acknowledgeFinalization"></a>`storage:workflow.acknowledgeFinalization` (rpc)

Commit the claimed intended terminal state exactly once.

Subject: `storage:workflow.acknowledgeFinalization`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `claimToken` | `string` | yes |
| `executionId` | `string` | yes |
| `settledAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `acknowledged` | `boolean` | yes |

### <a id="storage:workflow.claimFinalization"></a>`storage:workflow.claimFinalization` (rpc)

Atomically claim the sole terminal transition for a running execution.

Subject: `storage:workflow.claimFinalization`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `claim` | `{ executionId: string; workflowId: string; finalizerId: string; transitionKey: string; claimToken: string; intent: { status: "failed" \| "completed" \| "cancelled"; completedAt: number; error?: string \| undefined; reason?: string \| undefined; }; claimedAt: number; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claimed` | `boolean` | yes |

### <a id="storage:workflow.delete"></a>`storage:workflow.delete` (rpc)

Subject: `storage:workflow.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="storage:workflow.failFinalization"></a>`storage:workflow.failFinalization` (rpc)

Permanently fail a claimed transition and terminalize the execution as failed.

Subject: `storage:workflow.failFinalization`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `claimToken` | `string` | yes |
| `error` | `string` | yes |
| `executionId` | `string` | yes |
| `settledAt` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `failed` | `boolean` | yes |

### <a id="storage:workflow.get"></a>`storage:workflow.get` (rpc)

Subject: `storage:workflow.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: JsonValue \| undefined; } \| undefined; artifact?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: { kind: string; params: Record<string, JsonValue>; when?: Condition \| undefined; filter?: undefined; filterExpression?: undefined; }[] \| undefined; extensions?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: JsonObject; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { customCapabilities: string[]; maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; } \| null` | yes |

### <a id="storage:workflow.getExecution"></a>`storage:workflow.getExecution` (rpc)

Subject: `storage:workflow.getExecution`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `execution` | `{ id: string; workflowId: string; status: "failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: JsonObject \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: JsonObject \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; } \| null` | yes |

### <a id="storage:workflow.getFrame"></a>`storage:workflow.getFrame` (rpc)

Retrieve a single execution frame by `frameId`.

Stored gate rows from before workflow waiting was removed are kept and do not appear in this response; sums may still include their cost.

Subject: `storage:workflow.getFrame`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `frameId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frame` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "code-step" \| "agent-step" \| "parallel" \| "iterate" \| "iterate-chain" \| "loop"; path: string[]; status: "failed" \| "completed" \| "cancelled" \| "skipped" \| "pending" \| "running"; attempt: number; parentFrameId?: string \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: JsonValue \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; } \| null` | yes |

### <a id="storage:workflow.getRunContext"></a>`storage:workflow.getRunContext` (rpc)

Read the run-context snapshot by execution ID.
Called internally by the public `workflow.getRunContext` handler.

The snapshot is read as a stored context: `definitionSnapshot`
is opaque JSON, not re-parsed as a `WorkflowDefinitionSchema`, so a
stored snapshot that is no longer a valid definition stays readable here.

Subject: `storage:workflow.getRunContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `runContext` | `{ executionId: string; workflowId: string; source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; workerManifest: { contributionRefs: { packageName: string; version: string; entrypoint: string; integrity: string; }[]; }; inputs: JsonValue; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; triggerPayload: JsonObject; coordinatorSessionId: string; cancelSubject: string; env: Record<string, string>; createdAt: number; definitionSnapshot?: JsonValue \| undefined; config?: JsonObject \| undefined; triggerMode?: "immediate" \| "await-trigger" \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; terminalAuthority?: "authority" \| "worker" \| undefined; materializationSpec?: { kind: "local-directory"; workspaceId: string; rootDigest: string; sourcePath: string; } \| { kind: "workspace-snapshot"; snapshotId: string; digest: string; sourcePath: string; } \| undefined; } \| null` | yes |

### <a id="storage:workflow.getState"></a>`storage:workflow.getState` (rpc)

Read current execution state snapshot.

Subject: `storage:workflow.getState`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `state` | `{ executionId: string; sequence: number; value: JsonValue; } \| null` | yes |

### <a id="storage:workflow.initializeState"></a>`storage:workflow.initializeState` (rpc)

Initialize execution state snapshot at sequence 0.

Subject: `storage:workflow.initializeState`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `initialValue` | `JsonValue` | yes |

**Response:**

_Empty object._

### <a id="storage:workflow.list"></a>`storage:workflow.list` (rpc)

Answer is itself `WorkflowDefinitionListSchema`, without an envelope: readable
definitions plus the rows that could not be read.

Subject: `storage:workflow.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `rejected` | `{ id: string; reason: string; }[]` | yes |
| `workflows` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: JsonValue \| undefined; } \| undefined; artifact?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: { kind: string; params: Record<string, JsonValue>; when?: Condition \| undefined; filter?: undefined; filterExpression?: undefined; }[] \| undefined; extensions?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: JsonObject; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { customCapabilities: string[]; maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; }[]` | yes |

### <a id="storage:workflow.listClaimedFinalizations"></a>`storage:workflow.listClaimedFinalizations` (rpc)

Recover unsettled claims owned by one finalizer after restart.

Subject: `storage:workflow.listClaimedFinalizations`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `finalizerId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claims` | `{ executionId: string; workflowId: string; finalizerId: string; transitionKey: string; claimToken: string; intent: { status: "failed" \| "completed" \| "cancelled"; completedAt: number; error?: string \| undefined; reason?: string \| undefined; }; claimedAt: number; }[]` | yes |

### <a id="storage:workflow.listExecutionLinks"></a>`storage:workflow.listExecutionLinks` (rpc)

Subject: `storage:workflow.listExecutionLinks`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sourceExecutionId` | `string \| undefined` | no |
| `targetExecutionId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `links` | `{ sourceExecutionId: string; targetExecutionId: string; linkType: "triggered-by" \| "feedback-loop" \| "rerun-of"; metadata?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="storage:workflow.listExecutions"></a>`storage:workflow.listExecutions` (rpc)

List workflow executions by workflow ID or scope.

At least one of `workflowId` or `scope` is required. `limit` is optional
for callers and defaults to 50 during request parsing.

Subject: `storage:workflow.listExecutions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `artifactRef` | `{ kind: string; id: string; } \| undefined` | no |
| `cursor` | `{ startedAt: number; id: string; } \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `status` | `"failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing" \| undefined` | no |
| `workflowId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executions` | `{ id: string; workflowId: string; status: "failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: JsonObject \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: JsonObject \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; }[]` | yes |

### <a id="storage:workflow.listExecutionsByArtifactRefs"></a>`storage:workflow.listExecutionsByArtifactRefs` (rpc)

Batch-fetch recent executions grouped by artifact reference.
Internal storage implementation for the public `workflow.listExecutionsByArtifactRefs` subject.

Subject: `storage:workflow.listExecutionsByArtifactRefs`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limitPerRef` | `number \| undefined` | no |
| `refs` | `{ kind: string; id: string; }[]` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionsByRef` | `Record<string, { id: string; workflowId: string; status: "failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: JsonObject \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: JsonObject \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; }[]>` | yes |

### <a id="storage:workflow.listFrames"></a>`storage:workflow.listFrames` (rpc)

List all frames for a given execution.

Stored gate rows from before workflow waiting was removed are kept and do not appear in this response; sums may still include their cost.

Subject: `storage:workflow.listFrames`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frames` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "code-step" \| "agent-step" \| "parallel" \| "iterate" \| "iterate-chain" \| "loop"; path: string[]; status: "failed" \| "completed" \| "cancelled" \| "skipped" \| "pending" \| "running"; attempt: number; parentFrameId?: string \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: JsonValue \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }[]` | yes |

### <a id="storage:workflow.listSpans"></a>`storage:workflow.listSpans` (rpc)

List all spans for a given execution.

Stored gate rows from before workflow waiting was removed are kept and do not appear in this response; sums may still include their cost.

Subject: `storage:workflow.listSpans`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `spans` | `{ executionId: string; frameId: string; stepId: string; stepType: "code-step" \| "agent-step"; status: "failed" \| "completed" \| "skipped" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }[]` | yes |

### <a id="storage:workflow.listUnpublishedFinalizations"></a>`storage:workflow.listUnpublishedFinalizations` (rpc)

Recover settled terminal transitions whose lifecycle event was not durably marked published.

Subject: `storage:workflow.listUnpublishedFinalizations`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `finalizerId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `claims` | `{ executionId: string; workflowId: string; finalizerId: string; transitionKey: string; claimToken: string; intent: { status: "failed" \| "completed" \| "cancelled"; completedAt: number; error?: string \| undefined; reason?: string \| undefined; }; claimedAt: number; }[]` | yes |

### <a id="storage:workflow.patchState"></a>`storage:workflow.patchState` (rpc)

Apply a state mutation with optimistic concurrency control.

Subject: `storage:workflow.patchState`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `expectedSequence` | `number` | yes |
| `nextValue` | `JsonValue` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `patch` | `JsonPatchOperation[]` | yes |
| `sequence` | `number` | yes |
| `value` | `JsonValue` | yes |

### <a id="storage:workflow.publishFinalization"></a>`storage:workflow.publishFinalization` (rpc)

Replay a settled terminal lifecycle event until its publication is durably recorded.

Subject: `storage:workflow.publishFinalization`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `claim` | `{ executionId: string; workflowId: string; finalizerId: string; transitionKey: string; claimToken: string; intent: { status: "failed" \| "completed" \| "cancelled"; completedAt: number; error?: string \| undefined; reason?: string \| undefined; }; claimedAt: number; }` | yes |

**Response:**

_Empty object._

### <a id="storage:workflow.set"></a>`storage:workflow.set` (rpc)

Subject: `storage:workflow.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `{ id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: JsonValue \| undefined; } \| undefined; artifact?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: { kind: string; params: Record<string, JsonValue>; when?: unknown; filter?: undefined; filterExpression?: undefined; }[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; extensions?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: JsonObject \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="storage:workflow.setExecution"></a>`storage:workflow.setExecution` (rpc)

Subject: `storage:workflow.setExecution`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `execution` | `{ id: string; workflowId: string; status: "failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: JsonObject \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: JsonObject \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="storage:workflow.setExecutionLink"></a>`storage:workflow.setExecutionLink` (rpc)

Subject: `storage:workflow.setExecutionLink`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `link` | `{ sourceExecutionId: string; targetExecutionId: string; linkType: "triggered-by" \| "feedback-loop" \| "rerun-of"; metadata?: Record<string, unknown> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="storage:workflow.setExecutionStart"></a>`storage:workflow.setExecutionStart` (rpc)

Persist a newly-started execution and its worker run-context snapshot as
one storage transaction.

Subject: `storage:workflow.setExecutionStart`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `execution` | `{ id: string; workflowId: string; status: "failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: JsonObject \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: JsonObject \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; }` | yes |
| `executionLinks` | `{ sourceExecutionId: string; targetExecutionId: string; linkType: "triggered-by" \| "feedback-loop" \| "rerun-of"; metadata?: Record<string, unknown> \| undefined; }[] \| undefined` | no |
| `initialState` | `JsonValue \| undefined` | no |
| `runContext` | `{ executionId: string; workflowId: string; source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; coordinatorSessionId: string; cancelSubject: string; createdAt: number; definitionSnapshot?: { id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: JsonValue \| undefined; } \| undefined; artifact?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: { kind: string; params: Record<string, JsonValue>; when?: unknown; filter?: undefined; filterExpression?: undefined; }[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; extensions?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: JsonObject \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; } \| undefined; workerManifest?: { contributionRefs: { packageName: string; version: string; entrypoint: string; integrity: string; }[]; } \| undefined; inputs?: JsonValue \| undefined; config?: JsonObject \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; triggerPayload?: JsonObject \| undefined; triggerMode?: "immediate" \| "await-trigger" \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; env?: Record<string, string> \| undefined; terminalAuthority?: "authority" \| "worker" \| undefined; materializationSpec?: { kind: "local-directory"; workspaceId: string; rootDigest: string; sourcePath: string; } \| { kind: "workspace-snapshot"; snapshotId: string; digest: string; sourcePath: string; } \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `id` | `string` | yes |

### <a id="storage:workflow.setExternalExecutionStart"></a>`storage:workflow.setExternalExecutionStart` (rpc)

Atomically persist an external execution and its initial WorkLog rows.

Subject: `storage:workflow.setExternalExecutionStart`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `execution` | `{ id: string; workflowId: string; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; status: "running"; coordinatorSessionId?: string \| undefined; config?: JsonObject \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: JsonObject \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; }` | yes |
| `frame` | `{ executionId: string; frameId: string; nodeId: string; nodeType: "sequence" \| "code-step" \| "agent-step" \| "parallel" \| "iterate" \| "iterate-chain" \| "loop"; path: string[]; attempt: number; status: "running"; startedAt: number; iteration?: number \| undefined; branchKey?: string \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; error?: string \| undefined; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frameId` | `string \| undefined` | no |

### <a id="storage:workflow.setFrame"></a>`storage:workflow.setFrame` (rpc)

Upsert a single execution frame by `frameId`.
Called by the runtime when a frame is created or transitions state.
The `executionId` is required for insert; on conflict the full row is
replaced so both creation and state-update use the same subject.

Subject: `storage:workflow.setFrame`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frame` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "code-step" \| "agent-step" \| "parallel" \| "iterate" \| "iterate-chain" \| "loop"; path: string[]; status: "failed" \| "completed" \| "cancelled" \| "skipped" \| "pending" \| "running"; parentFrameId?: string \| undefined; attempt?: number \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: JsonValue \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frameId` | `string` | yes |

### <a id="storage:workflow.setRunContext"></a>`storage:workflow.setRunContext` (rpc)

Persist the run-context snapshot for a workflow execution.
Called by the executor after creating the execution row, before worker boot.

Subject: `storage:workflow.setRunContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `initialState` | `JsonValue \| undefined` | no |
| `runContext` | `{ executionId: string; workflowId: string; source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; coordinatorSessionId: string; cancelSubject: string; createdAt: number; definitionSnapshot?: { id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: JsonValue \| undefined; } \| undefined; artifact?: { kind: string; schemaVersion: number; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: { kind: string; params: Record<string, JsonValue>; when?: unknown; filter?: undefined; filterExpression?: undefined; }[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; extensions?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: JsonObject \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; } \| undefined; workerManifest?: { contributionRefs: { packageName: string; version: string; entrypoint: string; integrity: string; }[]; } \| undefined; inputs?: JsonValue \| undefined; config?: JsonObject \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; triggerPayload?: JsonObject \| undefined; triggerMode?: "immediate" \| "await-trigger" \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; env?: Record<string, string> \| undefined; terminalAuthority?: "authority" \| "worker" \| undefined; materializationSpec?: { kind: "local-directory"; workspaceId: string; rootDigest: string; sourcePath: string; } \| { kind: "workspace-snapshot"; snapshotId: string; digest: string; sourcePath: string; } \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

### <a id="storage:workflow.setSpan"></a>`storage:workflow.setSpan` (rpc)

Subject: `storage:workflow.setSpan`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `span` | `{ executionId: string; frameId: string; stepId: string; stepType: "code-step" \| "agent-step"; status: "failed" \| "completed" \| "skipped" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="storage:workflow.settleExternalExecution"></a>`storage:workflow.settleExternalExecution` (rpc)

Atomically settle an external execution and its WorkLog projection.

Subject: `storage:workflow.settleExternalExecution`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| undefined` | no |
| `error` | `string \| undefined` | no |
| `executionId` | `string` | yes |
| `frame` | `{ executionId: string; frameId: string; nodeId: string; nodeType: "sequence" \| "code-step" \| "agent-step" \| "parallel" \| "iterate" \| "iterate-chain" \| "loop"; path: string[]; attempt: number; status: "failed" \| "completed" \| "cancelled"; startedAt: number; completedAt: number; durationMs: number; iteration?: number \| undefined; branchKey?: string \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; error?: string \| undefined; } \| undefined` | no |
| `reason` | `string \| undefined` | no |
| `status` | `"failed" \| "completed" \| "cancelled"` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="storage:workflow.updateExecution"></a>`storage:workflow.updateExecution` (rpc)

Subject: `storage:workflow.updateExecution`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| null \| undefined` | no |
| `error` | `string \| null \| undefined` | no |
| `executionId` | `string` | yes |
| `reason` | `string \| null \| undefined` | no |
| `status` | `"failed" \| "completed" \| "cancelled" \| "pending" \| "running" \| "finalizing" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

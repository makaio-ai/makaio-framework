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
| `cancelPausedExecution` | [`storage:workflow.cancelPausedExecution`](#storage:workflow.cancelPausedExecution) | rpc | — |
| `delete` | [`storage:workflow.delete`](#storage:workflow.delete) | rpc | — |
| `get` | [`storage:workflow.get`](#storage:workflow.get) | rpc | — |
| `getExecution` | [`storage:workflow.getExecution`](#storage:workflow.getExecution) | rpc | — |
| `getFrame` | [`storage:workflow.getFrame`](#storage:workflow.getFrame) | rpc | — |
| `getGateInstance` | [`storage:workflow.getGateInstance`](#storage:workflow.getGateInstance) | rpc | — |
| `getRunContext` | [`storage:workflow.getRunContext`](#storage:workflow.getRunContext) | rpc | — |
| `list` | [`storage:workflow.list`](#storage:workflow.list) | rpc | — |
| `listExecutionLinks` | [`storage:workflow.listExecutionLinks`](#storage:workflow.listExecutionLinks) | rpc | — |
| `listExecutions` | [`storage:workflow.listExecutions`](#storage:workflow.listExecutions) | rpc | — |
| `listFrames` | [`storage:workflow.listFrames`](#storage:workflow.listFrames) | rpc | — |
| `listGateInstances` | [`storage:workflow.listGateInstances`](#storage:workflow.listGateInstances) | rpc | — |
| `listPausedGateTimeouts` | [`storage:workflow.listPausedGateTimeouts`](#storage:workflow.listPausedGateTimeouts) | rpc | — |
| `listSpans` | [`storage:workflow.listSpans`](#storage:workflow.listSpans) | rpc | — |
| `resolveWaitingGateInstance` | [`storage:workflow.resolveWaitingGateInstance`](#storage:workflow.resolveWaitingGateInstance) | rpc | — |
| `restorePausedGateResumeState` | [`storage:workflow.restorePausedGateResumeState`](#storage:workflow.restorePausedGateResumeState) | rpc | — |
| `set` | [`storage:workflow.set`](#storage:workflow.set) | rpc | — |
| `setExecution` | [`storage:workflow.setExecution`](#storage:workflow.setExecution) | rpc | — |
| `setExecutionLink` | [`storage:workflow.setExecutionLink`](#storage:workflow.setExecutionLink) | rpc | — |
| `setExecutionStart` | [`storage:workflow.setExecutionStart`](#storage:workflow.setExecutionStart) | rpc | — |
| `setFrame` | [`storage:workflow.setFrame`](#storage:workflow.setFrame) | rpc | — |
| `setGateInstance` | [`storage:workflow.setGateInstance`](#storage:workflow.setGateInstance) | rpc | — |
| `setRunContext` | [`storage:workflow.setRunContext`](#storage:workflow.setRunContext) | rpc | — |
| `setSpan` | [`storage:workflow.setSpan`](#storage:workflow.setSpan) | rpc | — |
| `updateExecution` | [`storage:workflow.updateExecution`](#storage:workflow.updateExecution) | rpc | — |

## Subject Details

### <a id="storage:workflow.cancelPausedExecution"></a>`storage:workflow.cancelPausedExecution` (rpc)

Cancel a paused execution and all of its still-waiting gate instances in
one transaction.

Subject: `storage:workflow.cancelPausedExecution`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number` | yes |
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `cancelled` | `boolean` | yes |
| `gates` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; status: "cancelled"; prompt?: string \| undefined; resumeData?: JsonValue \| undefined; resolvedAt?: number \| undefined; }[]` | yes |

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
| `workflow` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: Record<string, unknown>; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; } \| null` | yes |

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
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="storage:workflow.getFrame"></a>`storage:workflow.getFrame` (rpc)

Retrieve a single execution frame by `frameId`.

Subject: `storage:workflow.getFrame`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `frameId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frame` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "station" \| "delegate-agent" \| "delegate-role" \| "gate" \| "parallel" \| "iterate" \| "iterate-chain"; path: string[]; status: "completed" \| "cancelled" \| "skipped" \| "failed" \| "pending" \| "running" \| "waiting"; attempt: number; parentFrameId?: string \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: JsonValue \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; } \| null` | yes |

### <a id="storage:workflow.getGateInstance"></a>`storage:workflow.getGateInstance` (rpc)

Retrieve a gate instance by execution ID, node ID, and optional frame ID.
Provide `frameId` when the gate lives inside an `iterate` expansion.

Subject: `storage:workflow.getGateInstance`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frameId` | `string \| undefined` | no |
| `nodeId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `gate` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; status: "resumed" \| "cancelled" \| "rejected" \| "waiting" \| "timed-out"; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; prompt?: string \| undefined; resumeData?: JsonValue \| undefined; resolvedAt?: number \| undefined; } \| null` | yes |

### <a id="storage:workflow.getRunContext"></a>`storage:workflow.getRunContext` (rpc)

Read the run-context snapshot by execution ID.
Called internally by the public `workflow.getRunContext` handler.

Subject: `storage:workflow.getRunContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `runContext` | `{ executionId: string; workflowId: string; source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; workerManifest: { packages: { name: string; importPath: string; }[]; }; inputs: JsonValue; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; triggerPayload: Record<string, unknown>; coordinatorSessionId: string; cancelSubject: string; context: { repoPath: string; makaioHome: string; os: "darwin" \| "linux" \| "win32"; arch: string; worktree?: string \| undefined; }; env: Record<string, string>; createdAt: number; suspensionStrategy: "wait-in-process" \| "exit-and-redispatch" \| "exit-and-resume"; definitionSnapshot?: { id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: Record<string, unknown>; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; } \| undefined; config?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; dispatchMetadata?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="storage:workflow.list"></a>`storage:workflow.list` (rpc)

Subject: `storage:workflow.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `workflows` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: Record<string, unknown>; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; }[]` | yes |

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
| `links` | `{ sourceExecutionId: string; targetExecutionId: string; linkType: "triggered-by" \| "feedback-loop"; metadata?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="storage:workflow.listExecutions"></a>`storage:workflow.listExecutions` (rpc)

List workflow executions by workflow ID or scope.

At least one of `workflowId` or `scope` is required. `limit` is optional
for callers and defaults to 50 during request parsing.

Subject: `storage:workflow.listExecutions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `cursor` | `{ startedAt: number; id: string; } \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `status` | `"completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused" \| undefined` | no |
| `workflowId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executions` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="storage:workflow.listFrames"></a>`storage:workflow.listFrames` (rpc)

List all frames for a given execution.

Subject: `storage:workflow.listFrames`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frames` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "station" \| "delegate-agent" \| "delegate-role" \| "gate" \| "parallel" \| "iterate" \| "iterate-chain"; path: string[]; status: "completed" \| "cancelled" \| "skipped" \| "failed" \| "pending" \| "running" \| "waiting"; attempt: number; parentFrameId?: string \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: JsonValue \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }[]` | yes |

### <a id="storage:workflow.listGateInstances"></a>`storage:workflow.listGateInstances` (rpc)

List all gate instances for a given execution.

Subject: `storage:workflow.listGateInstances`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `gates` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; status: "resumed" \| "cancelled" \| "rejected" \| "waiting" \| "timed-out"; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; prompt?: string \| undefined; resumeData?: JsonValue \| undefined; resolvedAt?: number \| undefined; }[]` | yes |

### <a id="storage:workflow.listPausedGateTimeouts"></a>`storage:workflow.listPausedGateTimeouts` (rpc)

List finite-timeout gate instances whose owning execution is still paused.

Used by the executor during startup to rehydrate long-lived timeout
wakeups for exit-based runs. This stays storage-local because it exposes
recovery state rather than a product-facing listing contract.

Subject: `storage:workflow.listPausedGateTimeouts`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `gates` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; status: "resumed" \| "cancelled" \| "rejected" \| "waiting" \| "timed-out"; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; prompt?: string \| undefined; resumeData?: JsonValue \| undefined; resolvedAt?: number \| undefined; }[]` | yes |

### <a id="storage:workflow.listSpans"></a>`storage:workflow.listSpans` (rpc)

Subject: `storage:workflow.listSpans`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `spans` | `{ executionId: string; frameId: string; stepId: string; stepType: "station" \| "delegate-agent" \| "delegate-role" \| "gate"; status: "completed" \| "skipped" \| "failed" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }[]` | yes |

### <a id="storage:workflow.resolveWaitingGateInstance"></a>`storage:workflow.resolveWaitingGateInstance` (rpc)

Resolve a waiting gate instance with compare-and-set semantics.

Used for manual responses to paused exit-based gates. Only the first
request that observes the persisted gate in `waiting` status wins; all
later responses leave the row unchanged and return `accepted: false`.

Subject: `storage:workflow.resolveWaitingGateInstance`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `gate` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; status: "resumed" \| "rejected"; prompt?: string \| undefined; resumeData?: unknown; resolvedAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `accepted` | `boolean` | yes |

### <a id="storage:workflow.restorePausedGateResumeState"></a>`storage:workflow.restorePausedGateResumeState` (rpc)

Restore a paused execution and its waiting gate in one transaction after
a resolved manual response fails to launch a resume runner.

Subject: `storage:workflow.restorePausedGateResumeState`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `execution` | `{ id: string; workflowId: string; inputs: unknown; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; status: "paused"; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; }` | yes |
| `gate` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; status: "waiting"; prompt?: string \| undefined; resumeData?: unknown; resolvedAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `gateId` | `string` | yes |

### <a id="storage:workflow.set"></a>`storage:workflow.set` (rpc)

Subject: `storage:workflow.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `{ id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; canvasLayout?: Record<string, unknown> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined; executionHints?: { [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined; }` | yes |

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
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; inputs: unknown; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; }` | yes |

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
| `link` | `{ sourceExecutionId: string; targetExecutionId: string; linkType: "triggered-by" \| "feedback-loop"; metadata?: Record<string, unknown> \| undefined; }` | yes |

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
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; inputs: unknown; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; }` | yes |
| `runContext` | `{ executionId: string; workflowId: string; source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; coordinatorSessionId: string; cancelSubject: string; context: { repoPath: string; makaioHome: string; os: "darwin" \| "linux" \| "win32"; arch: string; worktree?: string \| undefined; }; createdAt: number; definitionSnapshot?: { id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; canvasLayout?: Record<string, unknown> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined; executionHints?: { [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined; } \| undefined; workerManifest?: { packages?: { name: string; importPath: string; }[] \| undefined; } \| undefined; inputs?: unknown; config?: Record<string, unknown> \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; triggerPayload?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; executionHints?: { [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined; dispatchMetadata?: Record<string, unknown> \| undefined; env?: Record<string, string> \| undefined; suspensionStrategy?: "wait-in-process" \| "exit-and-redispatch" \| "exit-and-resume" \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `id` | `string` | yes |

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
| `frame` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "station" \| "delegate-agent" \| "delegate-role" \| "gate" \| "parallel" \| "iterate" \| "iterate-chain"; path: string[]; status: "completed" \| "cancelled" \| "skipped" \| "failed" \| "pending" \| "running" \| "waiting"; parentFrameId?: string \| undefined; attempt?: number \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: unknown; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frameId` | `string` | yes |

### <a id="storage:workflow.setGateInstance"></a>`storage:workflow.setGateInstance` (rpc)

Upsert a gate instance record.
Called when a gate node is entered and when it is resolved.

Subject: `storage:workflow.setGateInstance`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `gate` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; status: "resumed" \| "cancelled" \| "rejected" \| "waiting" \| "timed-out"; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; prompt?: string \| undefined; resumeData?: unknown; resolvedAt?: number \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="storage:workflow.setRunContext"></a>`storage:workflow.setRunContext` (rpc)

Persist the run-context snapshot for a workflow execution.
Called by the executor after creating the execution row, before worker boot.

Subject: `storage:workflow.setRunContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `runContext` | `{ executionId: string; workflowId: string; source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; coordinatorSessionId: string; cancelSubject: string; context: { repoPath: string; makaioHome: string; os: "darwin" \| "linux" \| "win32"; arch: string; worktree?: string \| undefined; }; createdAt: number; definitionSnapshot?: { id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; canvasLayout?: Record<string, unknown> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined; executionHints?: { [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined; } \| undefined; workerManifest?: { packages?: { name: string; importPath: string; }[] \| undefined; } \| undefined; inputs?: unknown; config?: Record<string, unknown> \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; triggerPayload?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; executionHints?: { [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined; dispatchMetadata?: Record<string, unknown> \| undefined; env?: Record<string, string> \| undefined; suspensionStrategy?: "wait-in-process" \| "exit-and-redispatch" \| "exit-and-resume" \| undefined; }` | yes |

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
| `span` | `{ executionId: string; frameId: string; stepId: string; stepType: "station" \| "delegate-agent" \| "delegate-role" \| "gate"; status: "completed" \| "skipped" \| "failed" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

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
| `status` | `"completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

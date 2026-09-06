---
title: "worker"
editUrl: false
prev: false
next: false
---

# `worker`

| Field | Value |
|-------|-------|
| Prefix | `worker` |
| Namespace constant | `WorkerNamespace` |
| Subjects constant | `WorkerSubjects` |
| Kind | bus |
| Schema record | `WorkerSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/worker/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `control.bootstrap.claim` | [`worker.control.bootstrap.claim`](#worker.control.bootstrap.claim) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `control.outcome.submit` | [`worker.control.outcome.submit`](#worker.control.outcome.submit) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `dispatch` | [`worker.dispatch`](#worker.dispatch) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.booting` | [`worker.lifecycle.booting`](#worker.lifecycle.booting) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.busy` | [`worker.lifecycle.busy`](#worker.lifecycle.busy) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.completed` | [`worker.lifecycle.completed`](#worker.lifecycle.completed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.failed` | [`worker.lifecycle.failed`](#worker.lifecycle.failed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.paused` | [`worker.lifecycle.paused`](#worker.lifecycle.paused) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.provisioning` | [`worker.lifecycle.provisioning`](#worker.lifecycle.provisioning) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.ready` | [`worker.lifecycle.ready`](#worker.lifecycle.ready) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |
| `lifecycle.terminated` | [`worker.lifecycle.terminated`](#worker.lifecycle.terminated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker/schemas.ts) |

## Subject Details

### <a id="worker.control.bootstrap.claim"></a>`worker.control.bootstrap.claim` (rpc)

Worker claims its execution-scoped bus credentials during bootstrap.

The Worker Runtime authenticates its WebSocket connection as a bootstrap peer, then
presents its execution/attempt identity. The server validates that trusted
transport identity and the durable allocation before exchanging it for an
execution-scoped `busAuthSecret` used for subsequent communication.

Subject: `worker.control.bootstrap.claim`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `busAuthSecret` | `string` | yes |
| `busUrl` | `string` | yes |

### <a id="worker.control.outcome.submit"></a>`worker.control.outcome.submit` (rpc)

Worker submits a terminal workflow outcome for durable acknowledgement.

The Authority validates the attempt, commits the outcome through the
injected repository, and returns an ACK decision. Workers must not
exit until they receive the ACK.

Subject: `worker.control.outcome.submit`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `result` | `{ executionId: string; workflowId: string; status: "completed"; artifact?: { kind: string; id: string; revision: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; schemaVersion: string; data: Record<string, unknown>; relations: { type: string; target: unknown; }[]; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; confidence?: { level: "assumed" \| "inferred" \| "stated" \| "confirmed" \| "verified"; basis: { kind: string; actor: { kind: string; id: string; displayName?: string \| undefined; }; timestamp: number; detail?: string \| undefined; evidenceRef?: unknown; }[]; } \| undefined; representations?: { markdown?: string \| undefined; summary?: string \| undefined; plaintext?: string \| undefined; } \| undefined; createdAt?: number \| undefined; } \| undefined; } \| { executionId: string; workflowId: string; status: "failed"; error: string; } \| { executionId: string; workflowId: string; status: "cancelled"; reason?: string \| undefined; } \| { executionId: string; workflowId: string; status: "paused"; pausedAtGateId: string; pausedAtFrameId: string; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"accepted" \| "duplicate" \| "fenced" \| "conflict"` | yes |

### <a id="worker.dispatch"></a>`worker.dispatch` (rpc)

Dispatch a workflow execution to a Worker dispatcher.

Subject: `worker.dispatch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; executionId: string; workflowId: string; coordinatorSessionId: string; cancelSubject: string; definition?: { id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: JsonValue \| undefined; } \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: { kind: string; params: Record<string, JsonValue>; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; }[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; } \| undefined; triggerPayload?: Record<string, unknown> \| undefined; triggerMode?: "immediate" \| "await-trigger" \| undefined; inputs?: JsonValue \| undefined; config?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; busUrl?: string \| undefined; busAuth?: { kind: "none"; } \| { kind: "hmac"; secret: string; } \| undefined; env?: Record<string, string> \| undefined; suspensionStrategy?: "wait-in-process" \| "exit-and-redispatch" \| "exit-and-resume" \| undefined; terminalAuthority?: "authority" \| "worker" \| undefined; materializationSpec?: { kind: "local-directory"; workspaceId: string; rootDigest: string; sourcePath: string; } \| { kind: "workspace-snapshot"; snapshotId: string; digest: string; sourcePath: string; } \| undefined; }` | yes |
| `executionAttemptId` | `string` | yes |
| `manifest` | `{ contributionRefs: { packageName: string; version: string; entrypoint: string; integrity: string; }[]; } \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `requirements` | `{ maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `allocationRef` | `{ version: 1; providerId: string; providerData: Record<string, unknown>; }` | yes |
| `executionAttemptId` | `string` | yes |

### <a id="worker.lifecycle.booting"></a>`worker.lifecycle.booting` (event)

Environment is initialising (importing packages, connecting to bus).

Subject: `worker.lifecycle.booting`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker.lifecycle.busy"></a>`worker.lifecycle.busy` (event)

Worker Runtime has started executing the workflow.

Subject: `worker.lifecycle.busy`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker.lifecycle.completed"></a>`worker.lifecycle.completed` (event)

Execution finished successfully.

Subject: `worker.lifecycle.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker.lifecycle.failed"></a>`worker.lifecycle.failed` (event)

Execution terminated with an error.

Subject: `worker.lifecycle.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `error` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker.lifecycle.paused"></a>`worker.lifecycle.paused` (event)

Worker has suspended at a gate and the Worker Runtime has exited.

Emitted by providers using `exit-and-redispatch` or `exit-and-resume`
suspension strategies before the environment tears down. In-process
providers that block at the gate do not emit this event.

Subject: `worker.lifecycle.paused`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `pausedAtFrameId` | `string` | yes |
| `pausedAtGateId` | `string` | yes |

### <a id="worker.lifecycle.provisioning"></a>`worker.lifecycle.provisioning` (event)

Dispatch has selected a provider; Worker allocation is in progress.

Subject: `worker.lifecycle.provisioning`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker.lifecycle.ready"></a>`worker.lifecycle.ready` (event)

Worker Runtime is connected and ready to accept work.

Projected by the worker pool from `execution-attempt.runtime.ready`, which is
the subject that carries the proven runtime endpoint. This event stays a plain
lifecycle payload: adapter composition is a workflow-runtime concern and is not
part of the readiness surface.

Subject: `worker.lifecycle.ready`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker.lifecycle.terminated"></a>`worker.lifecycle.terminated` (event)

Worker environment has been torn down.

Subject: `worker.lifecycle.terminated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `reason` | `string \| undefined` | no |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

---
title: "worker-node"
editUrl: false
prev: false
next: false
---

# `worker-node`

| Field | Value |
|-------|-------|
| Prefix | `worker-node` |
| Namespace constant | `WorkerNodeNamespace` |
| Subjects constant | `WorkerNodeSubjects` |
| Kind | bus |
| Schema record | `WorkerNodeSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/worker-node/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `control.attempt-ready` | [`worker-node.control.attempt-ready`](#worker-node.control.attempt-ready) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `control.bootstrap.claim` | [`worker-node.control.bootstrap.claim`](#worker-node.control.bootstrap.claim) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `control.outcome.submit` | [`worker-node.control.outcome.submit`](#worker-node.control.outcome.submit) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `dispatch` | [`worker-node.dispatch`](#worker-node.dispatch) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.booting` | [`worker-node.lifecycle.booting`](#worker-node.lifecycle.booting) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.busy` | [`worker-node.lifecycle.busy`](#worker-node.lifecycle.busy) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.completed` | [`worker-node.lifecycle.completed`](#worker-node.lifecycle.completed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.failed` | [`worker-node.lifecycle.failed`](#worker-node.lifecycle.failed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.paused` | [`worker-node.lifecycle.paused`](#worker-node.lifecycle.paused) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.provisioning` | [`worker-node.lifecycle.provisioning`](#worker-node.lifecycle.provisioning) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.ready` | [`worker-node.lifecycle.ready`](#worker-node.lifecycle.ready) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |
| `lifecycle.terminated` | [`worker-node.lifecycle.terminated`](#worker-node.lifecycle.terminated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/worker-node/schemas.ts) |

## Subject Details

### <a id="worker-node.control.attempt-ready"></a>`worker-node.control.attempt-ready` (event)

Worker reports that it has booted, connected to the bus, and is ready
to execute the workflow for its assigned attempt.

The Authority and lifecycle emitters consume this to transition the
attempt into the active execution phase.

Subject: `worker-node.control.attempt-ready`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapters` | `string[] \| undefined` | no |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |

### <a id="worker-node.control.bootstrap.claim"></a>`worker-node.control.bootstrap.claim` (rpc)

Worker node claims its execution-scoped bus credentials during bootstrap.

The node authenticates its WebSocket connection as a bootstrap peer, then
presents its execution/attempt identity. The server validates that trusted
transport identity and the durable allocation before exchanging it for an
execution-scoped `busAuthSecret` used for subsequent communication.

Subject: `worker-node.control.bootstrap.claim`
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

### <a id="worker-node.control.outcome.submit"></a>`worker-node.control.outcome.submit` (rpc)

Worker submits a terminal workflow outcome for durable acknowledgement.

The Authority validates the attempt, commits the outcome through the
injected repository, and returns an ACK decision. Workers must not
exit until they receive the ACK.

Subject: `worker-node.control.outcome.submit`
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
| `decision` | `"accepted" \| "duplicate" \| "conflict" \| "fenced"` | yes |

### <a id="worker-node.dispatch"></a>`worker-node.dispatch` (rpc)

Dispatch a workflow execution to a WorkerNode dispatcher.

Subject: `worker-node.dispatch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ source: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }; executionId: string; workflowId: string; coordinatorSessionId: string; cancelSubject: string; definition?: { id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; state?: { schema: Record<string, JsonValue>; initial?: unknown; } \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; canvasLayout?: Record<string, unknown> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined; executableSource?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; } \| undefined; requirements?: { maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined; successFinalizerId?: string \| undefined; } \| undefined; triggerPayload?: Record<string, unknown> \| undefined; inputs?: unknown; config?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; busUrl?: string \| undefined; busAuth?: { kind: "none"; } \| { kind: "hmac"; secret: string; } \| undefined; env?: Record<string, string> \| undefined; suspensionStrategy?: "wait-in-process" \| "exit-and-redispatch" \| "exit-and-resume" \| undefined; terminalAuthority?: "authority" \| "worker" \| undefined; materializationSpec?: { kind: "local-directory"; workspaceId: string; rootDigest: string; sourcePath: string; } \| { kind: "workspace-snapshot"; snapshotId: string; digest: string; sourcePath: string; } \| undefined; }` | yes |
| `executionAttemptId` | `string` | yes |
| `manifest` | `{ contributionRefs: { packageName: string; version: string; entrypoint: string; integrity: string; }[]; } \| undefined` | no |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `requirements` | `{ maxRuntimeMs?: number \| undefined; persistentStorage?: boolean \| undefined; customCapabilities?: string[] \| undefined; recoverableAllocation?: boolean \| undefined; materializationModes?: ("local-directory" \| "workspace-snapshot")[] \| undefined; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `allocationRef` | `{ version: 1; providerId: string; providerData: Record<string, unknown>; }` | yes |
| `executionAttemptId` | `string` | yes |

### <a id="worker-node.lifecycle.booting"></a>`worker-node.lifecycle.booting` (event)

Environment is initialising (importing packages, connecting to bus).

Subject: `worker-node.lifecycle.booting`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker-node.lifecycle.busy"></a>`worker-node.lifecycle.busy` (event)

Node has started executing the workflow.

Subject: `worker-node.lifecycle.busy`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker-node.lifecycle.completed"></a>`worker-node.lifecycle.completed` (event)

Execution finished successfully.

Subject: `worker-node.lifecycle.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker-node.lifecycle.failed"></a>`worker-node.lifecycle.failed` (event)

Execution terminated with an error.

Subject: `worker-node.lifecycle.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `error` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker-node.lifecycle.paused"></a>`worker-node.lifecycle.paused` (event)

Node has suspended at a gate and the worker has exited.

Emitted by providers using `exit-and-redispatch` or `exit-and-resume`
suspension strategies before the environment tears down. In-process
providers that block at the gate do not emit this event.

Subject: `worker-node.lifecycle.paused`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |
| `pausedAtFrameId` | `string` | yes |
| `pausedAtGateId` | `string` | yes |

### <a id="worker-node.lifecycle.provisioning"></a>`worker-node.lifecycle.provisioning` (event)

Dispatch has selected a provider; node allocation is in progress.

Subject: `worker-node.lifecycle.provisioning`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker-node.lifecycle.ready"></a>`worker-node.lifecycle.ready` (event)

Node is connected and ready to accept work.

Subject: `worker-node.lifecycle.ready`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapters` | `string[] \| undefined` | no |
| `environment` | `string` | yes |
| `executionAttemptId` | `string` | yes |
| `executionId` | `string` | yes |
| `metadata` | `Record<string, unknown> \| undefined` | no |

### <a id="worker-node.lifecycle.terminated"></a>`worker-node.lifecycle.terminated` (event)

Node environment has been torn down.

Subject: `worker-node.lifecycle.terminated`
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

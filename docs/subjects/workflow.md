---
title: "workflow"
editUrl: false
prev: false
next: false
---

# `workflow`

| Field | Value |
|-------|-------|
| Prefix | `workflow` |
| Namespace constant | `WorkflowNamespace` |
| Subjects constant | `WorkflowSubjects` |
| Kind | bus |
| Schema record | `WorkflowSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/workflow/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/workflow/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `artifact.updated` | [`workflow.artifact.updated`](#workflow.artifact.updated) | event | — |
| `cancel` | [`workflow.cancel`](#workflow.cancel) | rpc | — |
| `definition.created` | [`workflow.definition.created`](#workflow.definition.created) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/workflow/schemas.ts) |
| `definition.deleted` | [`workflow.definition.deleted`](#workflow.definition.deleted) | event | — |
| `definition.updated` | [`workflow.definition.updated`](#workflow.definition.updated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/workflow/schemas.ts) |
| `deleteDefinition` | [`workflow.deleteDefinition`](#workflow.deleteDefinition) | rpc | — |
| `dynamic.materialized` | [`workflow.dynamic.materialized`](#workflow.dynamic.materialized) | event | — |
| `execution.cancelled` | [`workflow.execution.cancelled`](#workflow.execution.cancelled) | event | — |
| `execution.completed` | [`workflow.execution.completed`](#workflow.execution.completed) | event | — |
| `execution.failed` | [`workflow.execution.failed`](#workflow.execution.failed) | event | — |
| `execution.paused` | [`workflow.execution.paused`](#workflow.execution.paused) | event | — |
| `execution.progress` | [`workflow.execution.progress`](#workflow.execution.progress) | event | — |
| `execution.started` | [`workflow.execution.started`](#workflow.execution.started) | event | — |
| `frame.completed` | [`workflow.frame.completed`](#workflow.frame.completed) | event | — |
| `frame.failed` | [`workflow.frame.failed`](#workflow.frame.failed) | event | — |
| `frame.sessionLinked` | [`workflow.frame.sessionLinked`](#workflow.frame.sessionLinked) | event | — |
| `frame.started` | [`workflow.frame.started`](#workflow.frame.started) | event | — |
| `gate.awaitApproval` | [`workflow.gate.awaitApproval`](#workflow.gate.awaitApproval) | rpc | — |
| `gate.requested` | [`workflow.gate.requested`](#workflow.gate.requested) | event | — |
| `gate.resolved` | [`workflow.gate.resolved`](#workflow.gate.resolved) | event | — |
| `gate.respond` | [`workflow.gate.respond`](#workflow.gate.respond) | rpc | — |
| `gate.resumed` | [`workflow.gate.resumed`](#workflow.gate.resumed) | event | — |
| `gate.suspended` | [`workflow.gate.suspended`](#workflow.gate.suspended) | event | — |
| `getDefinition` | [`workflow.getDefinition`](#workflow.getDefinition) | rpc | — |
| `getExecution` | [`workflow.getExecution`](#workflow.getExecution) | rpc | — |
| `getRunContext` | [`workflow.getRunContext`](#workflow.getRunContext) | rpc | — |
| `listDefinitions` | [`workflow.listDefinitions`](#workflow.listDefinitions) | rpc | — |
| `listExecutionLinks` | [`workflow.listExecutionLinks`](#workflow.listExecutionLinks) | rpc | — |
| `listExecutions` | [`workflow.listExecutions`](#workflow.listExecutions) | rpc | — |
| `listFrames` | [`workflow.listFrames`](#workflow.listFrames) | rpc | — |
| `listGateInstances` | [`workflow.listGateInstances`](#workflow.listGateInstances) | rpc | — |
| `listSpans` | [`workflow.listSpans`](#workflow.listSpans) | rpc | — |
| `listTriggerTypes` | [`workflow.listTriggerTypes`](#workflow.listTriggerTypes) | rpc | — |
| `resolveAgent` | [`workflow.resolveAgent`](#workflow.resolveAgent) | rpc | — |
| `resolveRole` | [`workflow.resolveRole`](#workflow.resolveRole) | rpc | — |
| `runFile` | [`workflow.runFile`](#workflow.runFile) | rpc | — |
| `setDefinition` | [`workflow.setDefinition`](#workflow.setDefinition) | rpc | — |
| `setExecutionLink` | [`workflow.setExecutionLink`](#workflow.setExecutionLink) | rpc | — |
| `start` | [`workflow.start`](#workflow.start) | rpc | — |
| `step.beforeStart` | [`workflow.step.beforeStart`](#workflow.step.beforeStart) | event | — |
| `step.completed` | [`workflow.step.completed`](#workflow.step.completed) | event | — |
| `step.failed` | [`workflow.step.failed`](#workflow.step.failed) | event | — |
| `step.skipped` | [`workflow.step.skipped`](#workflow.step.skipped) | event | — |
| `step.started` | [`workflow.step.started`](#workflow.step.started) | event | — |
| `worklog.changed` | [`workflow.worklog.changed`](#workflow.worklog.changed) | event | — |
| `worklog.get` | [`workflow.worklog.get`](#workflow.worklog.get) | rpc | — |
| `worklog.list` | [`workflow.worklog.list`](#workflow.worklog.list) | rpc | — |
| `worklog.stats` | [`workflow.worklog.stats`](#workflow.worklog.stats) | rpc | — |

## Subject Details

### <a id="workflow.artifact.updated"></a>`workflow.artifact.updated` (event)

Emitted when a workflow frame produces an artifact update.

Enables "show me all artifact writes produced by this execution" queries
without scanning the artifact store.

Subject: `workflow.artifact.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifactRef` | `{ kind: string; id: string; }` | yes |
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `operation` | `string` | yes |
| `paths` | `string[]` | yes |
| `revision` | `string \| undefined` | no |

### <a id="workflow.cancel"></a>`workflow.cancel` (rpc)

Subject: `workflow.cancel`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `cancelled` | `boolean` | yes |

### <a id="workflow.definition.created"></a>`workflow.definition.created` (event)

Persisted workflow definition in the pipeline-primitive model.

The `root` field replaces the old flat `steps` DAG with a structured
`WorkflowSequenceNode` tree. All node schemas are function-free and
JSON-serializable so definitions can be stored, transferred over the bus,
and displayed in the visual editor without runtime coupling.

`inputSchema`, `configSchema`, and `outputSchema` are JSON Schema documents
(validated by `JsonSchemaRecordSchema`) for type-safe parameterization
and output contracts.

Subject: `workflow.definition.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined` | no |
| `canvasLayout` | `Record<string, unknown> \| undefined` | no |
| `configSchema` | `Record<string, JsonValue> \| undefined` | no |
| `description` | `string \| undefined` | no |
| `executionHints` | `{ [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `id` | `string` | yes |
| `inputSchema` | `Record<string, JsonValue> \| undefined` | no |
| `name` | `string \| undefined` | no |
| `outputSchema` | `Record<string, JsonValue> \| undefined` | no |
| `root` | `{ id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }` | yes |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `source` | `{ kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `triggers` | `({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined` | no |

### <a id="workflow.definition.deleted"></a>`workflow.definition.deleted` (event)

Subject: `workflow.definition.deleted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="workflow.definition.updated"></a>`workflow.definition.updated` (event)

Persisted workflow definition in the pipeline-primitive model.

The `root` field replaces the old flat `steps` DAG with a structured
`WorkflowSequenceNode` tree. All node schemas are function-free and
JSON-serializable so definitions can be stored, transferred over the bus,
and displayed in the visual editor without runtime coupling.

`inputSchema`, `configSchema`, and `outputSchema` are JSON Schema documents
(validated by `JsonSchemaRecordSchema`) for type-safe parameterization
and output contracts.

Subject: `workflow.definition.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifact` | `{ kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined` | no |
| `canvasLayout` | `Record<string, unknown> \| undefined` | no |
| `configSchema` | `Record<string, JsonValue> \| undefined` | no |
| `description` | `string \| undefined` | no |
| `executionHints` | `{ [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `id` | `string` | yes |
| `inputSchema` | `Record<string, JsonValue> \| undefined` | no |
| `name` | `string \| undefined` | no |
| `outputSchema` | `Record<string, JsonValue> \| undefined` | no |
| `root` | `{ id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }` | yes |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `source` | `{ kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `triggers` | `({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined` | no |

### <a id="workflow.deleteDefinition"></a>`workflow.deleteDefinition` (rpc)

Subject: `workflow.deleteDefinition`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="workflow.dynamic.materialized"></a>`workflow.dynamic.materialized` (event)

Emitted when a dynamic region's factory is invoked and produces nodes.

Enables tooling to trace which factory produced which nodes in a given
execution without scanning the full frame tree.

Subject: `workflow.dynamic.materialized`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `factoryId` | `string` | yes |
| `frameId` | `string` | yes |
| `materializedNodes` | `number` | yes |

### <a id="workflow.execution.cancelled"></a>`workflow.execution.cancelled` (event)

Subject: `workflow.execution.cancelled`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| undefined` | no |
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `workflowId` | `string` | yes |

### <a id="workflow.execution.completed"></a>`workflow.execution.completed` (event)

Subject: `workflow.execution.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| undefined` | no |
| `executionId` | `string` | yes |
| `totalDuration` | `number` | yes |
| `workflowId` | `string` | yes |

### <a id="workflow.execution.failed"></a>`workflow.execution.failed` (event)

Subject: `workflow.execution.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| undefined` | no |
| `error` | `string` | yes |
| `executionId` | `string` | yes |
| `failedStepId` | `string \| undefined` | no |
| `workflowId` | `string` | yes |

### <a id="workflow.execution.paused"></a>`workflow.execution.paused` (event)

Emitted when a workflow execution parks at a gate and the worker exits.

Dispatched by providers using `exit-and-redispatch` or `exit-and-resume`
suspension strategies. In-process providers that block at the gate do not
emit this event.

All scalar fields are projected as telemetry attributes (`traceAll`) so
that collectors can filter persisted facts by `executionId` without a
request/response correlation ID (events do not carry one).

Subject: `workflow.execution.paused`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `pausedAtFrameId` | `string` | yes |
| `pausedAtGateId` | `string` | yes |
| `workflowId` | `string` | yes |

### <a id="workflow.execution.progress"></a>`workflow.execution.progress` (event)

Ephemeral progress signal emitted by a station handler via `ctx.updateProgress()`.

Progress events are not persisted as WorkLog entries. Observers and
materialization providers consume them for real-time projections.

Subject: `workflow.execution.progress`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `emittedAt` | `number` | yes |
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `nodeId` | `string` | yes |
| `progress` | `{ message: string; details?: string \| undefined; kind?: string \| undefined; metadata?: unknown; }` | yes |
| `workflowId` | `string` | yes |

### <a id="workflow.execution.started"></a>`workflow.execution.started` (event)

Subject: `workflow.execution.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `artifactRef` | `{ kind: string; id: string; } \| undefined` | no |
| `coordinatorSessionId` | `string \| undefined` | no |
| `executionId` | `string` | yes |
| `startedAt` | `number \| undefined` | no |
| `workflowId` | `string` | yes |

### <a id="workflow.frame.completed"></a>`workflow.frame.completed` (event)

Emitted by the runtime when a node's execution frame reaches a terminal
`completed` status.

Subject: `workflow.frame.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| undefined` | no |
| `duration` | `number \| undefined` | no |
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `nodeId` | `string` | yes |
| `output` | `unknown` | no |

### <a id="workflow.frame.failed"></a>`workflow.frame.failed` (event)

Emitted by the runtime when a node's execution frame reaches a terminal
`failed` status.

Subject: `workflow.frame.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `completedAt` | `number \| undefined` | no |
| `duration` | `number \| undefined` | no |
| `error` | `string` | yes |
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `nodeId` | `string` | yes |

### <a id="workflow.frame.sessionLinked"></a>`workflow.frame.sessionLinked` (event)

Emitted when a workflow frame becomes associated with an agent session.

The workflow runtime emits this after the subagent runtime reports the
child session ID. Consumers use the link to correlate `agent.*` telemetry
back to the workflow frame that spawned it.

Subject: `workflow.frame.sessionLinked`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `sessionId` | `string` | yes |

### <a id="workflow.frame.started"></a>`workflow.frame.started` (event)

Emitted by the runtime when a node's execution frame starts.

One event per frame entry. For structural nodes (`parallel`, `iterate`)
this fires when the container frame starts, before child frames are created.

Subject: `workflow.frame.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `nodeId` | `string` | yes |
| `nodeType` | `"sequence" \| "station" \| "delegate-agent" \| "delegate-role" \| "gate" \| "parallel" \| "iterate" \| "iterate-chain"` | yes |
| `parentFrameId` | `string \| undefined` | no |
| `path` | `string[]` | yes |
| `startedAt` | `number \| undefined` | no |

### <a id="workflow.gate.awaitApproval"></a>`workflow.gate.awaitApproval` (rpc)

Subject: `workflow.gate.awaitApproval`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `autoAction` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `message` | `string` | yes |
| `openedAt` | `number` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"gate"` | yes |
| `timeoutMs` | `number \| null` | yes |
| `title` | `string` | yes |
| `workflowId` | `string` | yes |
| `workflowName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"reject" \| "approve"` | yes |
| `reason` | `string \| undefined` | no |
| `source` | `"user" \| "timeout"` | yes |

### <a id="workflow.gate.requested"></a>`workflow.gate.requested` (event)

Payload emitted when a gate step requests human approval.
Extracted as a named constant so it can be reused by both the
`gate.requested` event schema and the `gate.awaitApproval` RPC request.

Subject: `workflow.gate.requested`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `autoAction` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `message` | `string` | yes |
| `openedAt` | `number` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"gate"` | yes |
| `timeoutMs` | `number \| null` | yes |
| `title` | `string` | yes |
| `workflowId` | `string` | yes |
| `workflowName` | `string` | yes |

### <a id="workflow.gate.resolved"></a>`workflow.gate.resolved` (event)

Subject: `workflow.gate.resolved`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `source` | `"user" \| "cancelled" \| "timeout"` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"gate"` | yes |

### <a id="workflow.gate.respond"></a>`workflow.gate.respond` (rpc)

Subject: `workflow.gate.respond`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `frameId` | `string \| undefined` | no |
| `gateId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `resumeData` | `unknown` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `accepted` | `boolean` | yes |

### <a id="workflow.gate.resumed"></a>`workflow.gate.resumed` (event)

Emitted when a gate node resumes execution after receiving a valid response.

The `resumeData` matches the gate's declared `resumeSchema`.

Subject: `workflow.gate.resumed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `nodeId` | `string` | yes |
| `resumeData` | `unknown` | yes |

### <a id="workflow.gate.suspended"></a>`workflow.gate.suspended` (event)

Emitted when a gate node suspends execution awaiting a response.

The `schema` field carries the JSON Schema for the expected `resumeData`,
serialized as an opaque record for display in approval UIs.

Subject: `workflow.gate.suspended`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `autoAction` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `frameId` | `string` | yes |
| `nodeId` | `string` | yes |
| `openedAt` | `number` | yes |
| `prompt` | `string \| undefined` | no |
| `schema` | `Record<string, JsonValue>` | yes |
| `timeoutMs` | `number \| null` | yes |
| `title` | `string \| undefined` | no |

### <a id="workflow.getDefinition"></a>`workflow.getDefinition` (rpc)

Subject: `workflow.getDefinition`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: Record<string, unknown>; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; } \| null` | yes |

### <a id="workflow.getExecution"></a>`workflow.getExecution` (rpc)

Subject: `workflow.getExecution`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; } \| null` | yes |

### <a id="workflow.getRunContext"></a>`workflow.getRunContext` (rpc)

Pull the persisted run-context snapshot for a workflow execution.

Called by executors (Piscina threads, Docker containers, remote workers)
after authenticating on the bus. The host validates the caller's identity
against the requested `executionId` before returning the snapshot.

Trust-boundary rules (enforced by the handler, not the schema):
- Local callers: always permitted.
- Direct HMAC callers: `peer.kind === 'workflow-execution' && peer.id === executionId`.
- Relay/E2E callers: authenticated and encrypted peer required.

Subject: `workflow.getRunContext`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `artifactRef` | `{ kind: string; id: string; } \| undefined` | no |
| `cancelSubject` | `string` | yes |
| `config` | `Record<string, unknown> \| undefined` | no |
| `context` | `{ repoPath: string; makaioHome: string; os: "darwin" \| "linux" \| "win32"; arch: string; worktree?: string \| undefined; }` | yes |
| `coordinatorSessionId` | `string` | yes |
| `createdAt` | `number` | yes |
| `definitionSnapshot` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: Record<string, unknown>; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; } \| undefined` | no |
| `dispatchMetadata` | `Record<string, unknown> \| undefined` | no |
| `env` | `Record<string, string>` | yes |
| `executionHints` | `{ [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined` | no |
| `executionId` | `string` | yes |
| `inputs` | `JsonValue` | yes |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }` | yes |
| `source` | `{ kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| { kind: "definition"; workflowId: string; }` | yes |
| `suspensionStrategy` | `"wait-in-process" \| "exit-and-redispatch" \| "exit-and-resume"` | yes |
| `triggerPayload` | `Record<string, unknown>` | yes |
| `workerManifest` | `{ packages: { name: string; importPath: string; }[]; }` | yes |
| `workflowId` | `string` | yes |

### <a id="workflow.listDefinitions"></a>`workflow.listDefinitions` (rpc)

Subject: `workflow.listDefinitions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `workflows` | `{ id: string; root: { id: string; type: "sequence"; nodes: WorkflowNode[]; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; canvasLayout?: Record<string, JsonValue> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; metadata: Record<string, unknown>; externalId?: string \| undefined; syncedAt?: string \| undefined; } \| undefined; executionHints?: { [x: string]: JsonValue; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: JsonValue; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, JsonValue> \| undefined; } \| undefined; }[]` | yes |

### <a id="workflow.listExecutionLinks"></a>`workflow.listExecutionLinks` (rpc)

List links between workflow executions.

Public read API for pipeline-level traces. Storage subjects remain
internal to the workflow subsystem.

Subject: `workflow.listExecutionLinks`
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

### <a id="workflow.listExecutions"></a>`workflow.listExecutions` (rpc)

List workflow executions by workflow ID or scope.

At least one of `workflowId` or `scope` is required. `limit` is optional
for callers and defaults to 50 during request parsing.

Subject: `workflow.listExecutions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `artifactRef` | `{ kind: string; id: string; } \| undefined` | no |
| `cursor` | `{ startedAt: number; id: string; } \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `status` | `"completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused" \| undefined` | no |
| `workflowId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executions` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; inputs: JsonValue; startedAt: number; scope: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; }; coordinatorSessionId?: string \| undefined; config?: Record<string, unknown> \| undefined; completedAt?: number \| undefined; error?: string \| undefined; reason?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; artifactRef?: { kind: string; id: string; } \| undefined; }[]` | yes |

### <a id="workflow.listFrames"></a>`workflow.listFrames` (rpc)

List persisted execution frames for a workflow execution.

This is the public read API for the runtime frame tree (per-node state,
tree paths, attempts, outputs). Note: `output` payloads can be large.
Storage subjects remain internal to the workflow subsystem.

Subject: `workflow.listFrames`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `frames` | `{ frameId: string; nodeId: string; nodeType: "sequence" \| "station" \| "delegate-agent" \| "delegate-role" \| "gate" \| "parallel" \| "iterate" \| "iterate-chain"; path: string[]; status: "completed" \| "cancelled" \| "skipped" \| "failed" \| "pending" \| "running" \| "waiting"; attempt: number; parentFrameId?: string \| undefined; iteration?: number \| undefined; branchKey?: string \| undefined; output?: JsonValue \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }[]` | yes |

### <a id="workflow.listGateInstances"></a>`workflow.listGateInstances` (rpc)

List persisted gate instances by execution and/or status.

This is the public read API for pending and resolved gate state — either
per execution via `executionId`, or a cross-execution gate inbox via the
`status` filter (e.g. `'waiting'`). At least one filter is required and
results are always limited. Storage subjects remain internal to the
workflow subsystem.

Subject: `workflow.listGateInstances`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `status` | `"resumed" \| "cancelled" \| "rejected" \| "waiting" \| "timed-out" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `gates` | `{ executionId: string; nodeId: string; frameId: string; schema: Record<string, JsonValue>; status: "resumed" \| "cancelled" \| "rejected" \| "waiting" \| "timed-out"; autoAction: "reject" \| "approve"; timeoutMs: number \| null; createdAt: number; prompt?: string \| undefined; resumeData?: JsonValue \| undefined; resolvedAt?: number \| undefined; }[]` | yes |

### <a id="workflow.listSpans"></a>`workflow.listSpans` (rpc)

List persisted step spans for a workflow execution.

This is the public read API for execution traces. Storage subjects remain
internal to the workflow subsystem.

Subject: `workflow.listSpans`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `spans` | `{ executionId: string; frameId: string; stepId: string; stepType: "station" \| "delegate-agent" \| "delegate-role" \| "gate"; status: "completed" \| "skipped" \| "failed" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }[]` | yes |

### <a id="workflow.listTriggerTypes"></a>`workflow.listTriggerTypes` (rpc)

Subject: `workflow.listTriggerTypes`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `triggerTypes` | `{ type: string; displayName: string; icon: string; category: string; configJsonSchema: Record<string, JsonValue>; outputJsonSchema: Record<string, JsonValue>; source: string; description?: string \| undefined; }[]` | yes |

### <a id="workflow.resolveAgent"></a>`workflow.resolveAgent` (rpc)

Resolve an explicit agent definition to its adapter configuration.
Called by the workflow executor when an agent step specifies `agentId`.

Subject: `workflow.resolveAgent`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `contextMode` | `"fork" \| "fresh" \| undefined` | no |
| `harnessId` | `string \| undefined` | no |
| `model` | `string \| undefined` | no |
| `providerContext` | `{ providerConfigId: string; definitionId: string; credentialRefs: Record<string, string & $brand<"CredentialRef">>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; } \| undefined` | no |
| `systemPrompt` | `string \| undefined` | no |

### <a id="workflow.resolveRole"></a>`workflow.resolveRole` (rpc)

Resolve a named role to its full adapter configuration.
Called by the workflow executor when an agent step specifies `role`.

Subject: `workflow.resolveRole`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `roleId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `contextMode` | `"fork" \| "fresh" \| undefined` | no |
| `harnessId` | `string \| undefined` | no |
| `model` | `string \| undefined` | no |
| `providerContext` | `{ providerConfigId: string; definitionId: string; credentialRefs: Record<string, string & $brand<"CredentialRef">>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; } \| undefined` | no |
| `systemPrompt` | `string \| undefined` | no |

### <a id="workflow.runFile"></a>`workflow.runFile` (rpc)

Run a workflow from a TypeScript or JavaScript source file.

The runtime loads the file, extracts the default-exported workflow
definition, registers it ephemerally (without persisting to storage),
and starts an execution. The response mirrors `WorkflowSchemas.start`
so callers can track the execution via the same lifecycle events.

Intended for developer workflows and CLI-driven one-shot executions.

Subject: `workflow.runFile`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `filePath` | `string` | yes |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `triggerPayload` | `Record<string, unknown> \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

### <a id="workflow.setDefinition"></a>`workflow.setDefinition` (rpc)

Subject: `workflow.setDefinition`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `{ id: string; root: { id: string; type: "sequence"; nodes: unknown; when?: string \| undefined; skip?: string \| undefined; writes?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; dataExpression?: string \| undefined; }[] \| undefined; }; name?: string \| undefined; description?: string \| undefined; inputSchema?: Record<string, JsonValue> \| undefined; configSchema?: Record<string, JsonValue> \| undefined; outputSchema?: Record<string, JsonValue> \| undefined; artifact?: { kind: string; schemaVersion: string; scope: { level: string; ids?: Record<string, string> \| undefined; }; resolve?: string \| undefined; create?: string \| undefined; statusPath?: string \| undefined; } \| undefined; triggers?: ({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined; scope?: { type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined; canvasLayout?: Record<string, unknown> \| undefined; source?: { kind: "editor"; } \| { kind: "extension"; extension: string; externalId?: string \| undefined; syncedAt?: string \| undefined; metadata?: Record<string, unknown> \| undefined; } \| undefined; executionHints?: { [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="workflow.setExecutionLink"></a>`workflow.setExecutionLink` (rpc)

Record a directed link between two workflow executions.

Public write API for cross-execution tracing (e.g. feedback loops,
trigger chains). Both executions must already exist — links are
foreign-keyed to `workflow_executions`. Upserts on (source, target).

Subject: `workflow.setExecutionLink`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `link` | `{ sourceExecutionId: string; targetExecutionId: string; linkType: "triggered-by" \| "feedback-loop"; metadata?: Record<string, unknown> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="workflow.start"></a>`workflow.start` (rpc)

Subject: `workflow.start`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `artifactRef` | `{ kind: string; id: string; } \| undefined` | no |
| `config` | `unknown` | no |
| `executionHints` | `{ [x: string]: unknown; source?: { kind: "path"; path: string; } \| { kind: "source"; filename: string; source: string; } \| undefined; requirements?: { [x: string]: unknown; isolation?: "local" \| "container" \| "remote" \| undefined; capabilities?: string[] \| undefined; } \| undefined; providers?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `input` | `unknown` | no |
| `parentSessionId` | `string \| undefined` | no |
| `scope` | `{ type: "global"; } \| { type: "workspace"; id: string; } \| { type: "session"; id: string; } \| { type: "external"; kind: string; id: string; } \| undefined` | no |
| `triggerPayload` | `Record<string, unknown> \| undefined` | no |
| `workflowId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

### <a id="workflow.step.beforeStart"></a>`workflow.step.beforeStart` (event)

Subject: `workflow.step.beforeStart`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"station" \| "delegate-agent" \| "delegate-role" \| "gate"` | yes |

### <a id="workflow.step.completed"></a>`workflow.step.completed` (event)

Subject: `workflow.step.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `duration` | `number` | yes |
| `executionId` | `string` | yes |
| `result` | `unknown` | no |
| `stepId` | `string` | yes |
| `stepType` | `"station" \| "delegate-agent" \| "delegate-role" \| "gate"` | yes |

### <a id="workflow.step.failed"></a>`workflow.step.failed` (event)

Subject: `workflow.step.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string` | yes |
| `executionId` | `string` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"station" \| "delegate-agent" \| "delegate-role" \| "gate"` | yes |

### <a id="workflow.step.skipped"></a>`workflow.step.skipped` (event)

Subject: `workflow.step.skipped`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `condition` | `string \| undefined` | no |
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `stepId` | `string` | yes |
| `stepType` | `"station" \| "delegate-agent" \| "delegate-role" \| "gate"` | yes |

### <a id="workflow.step.started"></a>`workflow.step.started` (event)

Subject: `workflow.step.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `sessionId` | `string \| undefined` | no |
| `stepId` | `string` | yes |
| `stepType` | `"station" \| "delegate-agent" \| "delegate-role" \| "gate"` | yes |
| `subagentId` | `string \| undefined` | no |

### <a id="workflow.worklog.changed"></a>`workflow.worklog.changed` (event)

Emitted when a WorkLog record for an execution is created or updated.

Subscribers can use this as a lightweight push notification to
invalidate cached summaries without polling.

Subject: `workflow.worklog.changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

### <a id="workflow.worklog.get"></a>`workflow.worklog.get` (rpc)

Retrieve the WorkLog execution summary for a single execution (RPC).

Returns the denormalized summary record used by execution summary views.
The summary is updated as execution events arrive.

Subject: `workflow.worklog.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `summary` | `{ executionId: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; startedAt: number; workflowName?: string \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; totalInputTokens?: number \| undefined; totalOutputTokens?: number \| undefined; totalEstimatedCost?: number \| undefined; error?: string \| undefined; failedNodeId?: string \| undefined; } \| null` | yes |

### <a id="workflow.worklog.list"></a>`workflow.worklog.list` (rpc)

List WorkLog execution summaries with optional filtering (RPC).

At least one of `workflowId` or `status` is recommended to avoid
unbounded scans; both are optional to support broad projection queries.

Subject: `workflow.worklog.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `limit` | `number \| undefined` | no |
| `offset` | `number \| undefined` | no |
| `status` | `"completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused" \| undefined` | no |
| `workflowId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `items` | `{ executionId: string; workflowId: string; status: "completed" \| "cancelled" \| "failed" \| "pending" \| "running" \| "paused"; startedAt: number; workflowName?: string \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; totalInputTokens?: number \| undefined; totalOutputTokens?: number \| undefined; totalEstimatedCost?: number \| undefined; error?: string \| undefined; failedNodeId?: string \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="workflow.worklog.stats"></a>`workflow.worklog.stats` (rpc)

Aggregate WorkLog execution statistics over an optional time window (RPC).

Filters apply to the execution `startedAt` timestamp; `since`/`until` are
inclusive epoch-millisecond bounds. All filters optional.

Subject: `workflow.worklog.stats`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `since` | `number \| undefined` | no |
| `until` | `number \| undefined` | no |
| `workflowId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `stats` | `{ total: number; byStatus: { pending: number; running: number; paused: number; completed: number; failed: number; cancelled: number; }; totalDurationMs: number; totalInputTokens: number; totalOutputTokens: number; totalEstimatedCost: number; }` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

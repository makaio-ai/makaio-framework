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
| `cancel` | [`workflow.cancel`](#workflow.cancel) | rpc | — |
| `definition.created` | [`workflow.definition.created`](#workflow.definition.created) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/workflow/schemas.ts) |
| `definition.deleted` | [`workflow.definition.deleted`](#workflow.definition.deleted) | event | — |
| `definition.updated` | [`workflow.definition.updated`](#workflow.definition.updated) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/workflow/schemas.ts) |
| `deleteDefinition` | [`workflow.deleteDefinition`](#workflow.deleteDefinition) | rpc | — |
| `execution.cancelled` | [`workflow.execution.cancelled`](#workflow.execution.cancelled) | event | — |
| `execution.completed` | [`workflow.execution.completed`](#workflow.execution.completed) | event | — |
| `execution.failed` | [`workflow.execution.failed`](#workflow.execution.failed) | event | — |
| `execution.started` | [`workflow.execution.started`](#workflow.execution.started) | event | — |
| `gate.requested` | [`workflow.gate.requested`](#workflow.gate.requested) | event | — |
| `gate.resolved` | [`workflow.gate.resolved`](#workflow.gate.resolved) | event | — |
| `gate.respond` | [`workflow.gate.respond`](#workflow.gate.respond) | rpc | — |
| `getDefinition` | [`workflow.getDefinition`](#workflow.getDefinition) | rpc | — |
| `getExecution` | [`workflow.getExecution`](#workflow.getExecution) | rpc | — |
| `listDefinitions` | [`workflow.listDefinitions`](#workflow.listDefinitions) | rpc | — |
| `listExecutions` | [`workflow.listExecutions`](#workflow.listExecutions) | rpc | — |
| `listTriggerTypes` | [`workflow.listTriggerTypes`](#workflow.listTriggerTypes) | rpc | — |
| `setDefinition` | [`workflow.setDefinition`](#workflow.setDefinition) | rpc | — |
| `start` | [`workflow.start`](#workflow.start) | rpc | — |
| `step.beforeStart` | [`workflow.step.beforeStart`](#workflow.step.beforeStart) | event | — |
| `step.completed` | [`workflow.step.completed`](#workflow.step.completed) | event | — |
| `step.failed` | [`workflow.step.failed`](#workflow.step.failed) | event | — |
| `step.skipped` | [`workflow.step.skipped`](#workflow.step.skipped) | event | — |
| `step.started` | [`workflow.step.started`](#workflow.step.started) | event | — |

## Subject Details

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

Schema typed as `z.ZodType<WorkflowDefinition, WorkflowDefinition>` for bus namespace registration.
Required because `z.lazy` erases the `Input` type parameter that `InferSchemaPayload` needs.

Subject: `workflow.definition.created`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `canvasLayout` | `Record<string, unknown> \| undefined` | no |
| `createdAt` | `number` | yes |
| `defaultExecutionTargetId` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `id` | `string` | yes |
| `inputs` | `{ name: string; type: "string" \| "boolean" \| "choice"; description?: string \| undefined; required?: boolean \| undefined; default?: string \| boolean \| undefined; options?: string[] \| undefined; }[] \| undefined` | no |
| `name` | `string` | yes |
| `projectId` | `string \| null` | yes |
| `scope` | `string` | yes |
| `steps` | `WorkflowStep[]` | yes |
| `triggers` | `({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined` | no |
| `updatedAt` | `number` | yes |

### <a id="workflow.definition.deleted"></a>`workflow.definition.deleted` (event)

Subject: `workflow.definition.deleted`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

### <a id="workflow.definition.updated"></a>`workflow.definition.updated` (event)

Schema typed as `z.ZodType<WorkflowDefinition, WorkflowDefinition>` for bus namespace registration.
Required because `z.lazy` erases the `Input` type parameter that `InferSchemaPayload` needs.

Subject: `workflow.definition.updated`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `canvasLayout` | `Record<string, unknown> \| undefined` | no |
| `createdAt` | `number` | yes |
| `defaultExecutionTargetId` | `string \| undefined` | no |
| `description` | `string \| undefined` | no |
| `id` | `string` | yes |
| `inputs` | `{ name: string; type: "string" \| "boolean" \| "choice"; description?: string \| undefined; required?: boolean \| undefined; default?: string \| boolean \| undefined; options?: string[] \| undefined; }[] \| undefined` | no |
| `name` | `string` | yes |
| `projectId` | `string \| null` | yes |
| `scope` | `string` | yes |
| `steps` | `WorkflowStep[]` | yes |
| `triggers` | `({ type: "manual"; } \| { type: "cron"; schedule: string; timezone?: string \| undefined; } \| { type: "webhook"; event: string; branch?: string \| undefined; repo?: string \| undefined; } \| { type: "extension"; extensionType: string; config?: Record<string, unknown> \| undefined; } \| { type: "bus-event"; subject: string; filter?: Record<string, string \| number \| boolean \| { $in: (string \| number \| boolean \| null)[]; } \| { $ne: string \| number \| boolean \| null; } \| { $exists: boolean; } \| { $startsWith: string; } \| { $endsWith: string; } \| null> \| undefined; filterExpression?: string \| undefined; })[] \| undefined` | no |
| `updatedAt` | `number` | yes |

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

### <a id="workflow.execution.cancelled"></a>`workflow.execution.cancelled` (event)

Subject: `workflow.execution.cancelled`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |

### <a id="workflow.execution.completed"></a>`workflow.execution.completed` (event)

Subject: `workflow.execution.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `totalDuration` | `number` | yes |

### <a id="workflow.execution.failed"></a>`workflow.execution.failed` (event)

Subject: `workflow.execution.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string` | yes |
| `executionId` | `string` | yes |
| `failedStepId` | `string \| undefined` | no |

### <a id="workflow.execution.started"></a>`workflow.execution.started` (event)

Subject: `workflow.execution.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `coordinatorSessionId` | `string \| undefined` | no |
| `executionId` | `string` | yes |
| `workflowId` | `string` | yes |

### <a id="workflow.gate.requested"></a>`workflow.gate.requested` (event)

Subject: `workflow.gate.requested`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `autoAction` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `message` | `string` | yes |
| `openedAt` | `number` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |
| `timeoutMs` | `number \| null` | yes |
| `title` | `string` | yes |
| `workflowId` | `string` | yes |
| `workflowName` | `string` | yes |

### <a id="workflow.gate.resolved"></a>`workflow.gate.resolved` (event)

Subject: `workflow.gate.resolved`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `action` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `source` | `"user" \| "timeout"` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |

### <a id="workflow.gate.respond"></a>`workflow.gate.respond` (rpc)

Subject: `workflow.gate.respond`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"reject" \| "approve"` | yes |
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `stepId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `accepted` | `boolean` | yes |

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
| `workflow` | `WorkflowDefinition \| null` | yes |

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
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "pending" \| "failed" \| "running" \| "paused"; inputs: Record<string, unknown>; steps: Record<string, { status: "completed" \| "skipped" \| "pending" \| "failed" \| "running" \| "waiting"; sessionId?: string \| undefined; subagentId?: string \| undefined; result?: string \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }>; startedAt: number; coordinatorSessionId?: string \| undefined; currentStepId?: string \| undefined; completedAt?: number \| undefined; error?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="workflow.listDefinitions"></a>`workflow.listDefinitions` (rpc)

Subject: `workflow.listDefinitions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `workflows` | `WorkflowDefinition[]` | yes |

### <a id="workflow.listExecutions"></a>`workflow.listExecutions` (rpc)

Subject: `workflow.listExecutions`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `status` | `"completed" \| "cancelled" \| "pending" \| "failed" \| "running" \| "paused" \| undefined` | no |
| `workflowId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `executions` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "pending" \| "failed" \| "running" \| "paused"; inputs: Record<string, unknown>; steps: Record<string, { status: "completed" \| "skipped" \| "pending" \| "failed" \| "running" \| "waiting"; sessionId?: string \| undefined; subagentId?: string \| undefined; result?: string \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }>; startedAt: number; coordinatorSessionId?: string \| undefined; currentStepId?: string \| undefined; completedAt?: number \| undefined; error?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; }[]` | yes |

### <a id="workflow.listTriggerTypes"></a>`workflow.listTriggerTypes` (rpc)

Subject: `workflow.listTriggerTypes`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `triggerTypes` | `{ type: string; displayName: string; icon: string; category: string; configJsonSchema: Record<string, unknown>; outputJsonSchema: Record<string, unknown>; source: string; description?: string \| undefined; }[]` | yes |

### <a id="workflow.setDefinition"></a>`workflow.setDefinition` (rpc)

Subject: `workflow.setDefinition`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `WorkflowDefinitionInput` | yes |

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
| `inputs` | `Record<string, unknown> \| undefined` | no |
| `parentSessionId` | `string \| undefined` | no |
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
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |

### <a id="workflow.step.completed"></a>`workflow.step.completed` (event)

Subject: `workflow.step.completed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `duration` | `number` | yes |
| `executionId` | `string` | yes |
| `result` | `string \| undefined` | no |
| `stepId` | `string` | yes |
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |

### <a id="workflow.step.failed"></a>`workflow.step.failed` (event)

Subject: `workflow.step.failed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string` | yes |
| `executionId` | `string` | yes |
| `stepId` | `string` | yes |
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |

### <a id="workflow.step.skipped"></a>`workflow.step.skipped` (event)

Subject: `workflow.step.skipped`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `condition` | `string \| undefined` | no |
| `executionId` | `string` | yes |
| `reason` | `string \| undefined` | no |
| `stepId` | `string` | yes |
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |

### <a id="workflow.step.started"></a>`workflow.step.started` (event)

Subject: `workflow.step.started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `executionId` | `string` | yes |
| `sessionId` | `string \| undefined` | no |
| `stepId` | `string` | yes |
| `stepType` | `"agent" \| "shell" \| "gate"` | yes |
| `subagentId` | `string \| undefined` | no |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

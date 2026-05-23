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
| `delete` | [`storage:workflow.delete`](#storage:workflow.delete) | rpc | — |
| `get` | [`storage:workflow.get`](#storage:workflow.get) | rpc | — |
| `getExecution` | [`storage:workflow.getExecution`](#storage:workflow.getExecution) | rpc | — |
| `list` | [`storage:workflow.list`](#storage:workflow.list) | rpc | — |
| `listExecutionLinks` | [`storage:workflow.listExecutionLinks`](#storage:workflow.listExecutionLinks) | rpc | — |
| `listExecutions` | [`storage:workflow.listExecutions`](#storage:workflow.listExecutions) | rpc | — |
| `listSpans` | [`storage:workflow.listSpans`](#storage:workflow.listSpans) | rpc | — |
| `set` | [`storage:workflow.set`](#storage:workflow.set) | rpc | — |
| `setExecution` | [`storage:workflow.setExecution`](#storage:workflow.setExecution) | rpc | — |
| `setExecutionLink` | [`storage:workflow.setExecutionLink`](#storage:workflow.setExecutionLink) | rpc | — |
| `setSpan` | [`storage:workflow.setSpan`](#storage:workflow.setSpan) | rpc | — |

## Subject Details

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
| `workflow` | `WorkflowDefinition \| null` | yes |

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
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "pending" \| "failed" \| "running" \| "paused"; inputs: Record<string, unknown>; steps: Record<string, { status: "completed" \| "skipped" \| "pending" \| "failed" \| "running" \| "waiting"; sessionId?: string \| undefined; subagentId?: string \| undefined; result?: string \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }>; startedAt: number; coordinatorSessionId?: string \| undefined; currentStepId?: string \| undefined; completedAt?: number \| undefined; error?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; } \| null` | yes |

### <a id="storage:workflow.list"></a>`storage:workflow.list` (rpc)

Subject: `storage:workflow.list`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `workflows` | `WorkflowDefinition[]` | yes |

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

Subject: `storage:workflow.listExecutions`
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
| `spans` | `{ executionId: string; stepId: string; stepType: "agent" \| "shell" \| "gate"; status: "completed" \| "skipped" \| "failed" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }[]` | yes |

### <a id="storage:workflow.set"></a>`storage:workflow.set` (rpc)

Subject: `storage:workflow.set`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `workflow` | `WorkflowDefinitionInput` | yes |

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
| `execution` | `{ id: string; workflowId: string; status: "completed" \| "cancelled" \| "pending" \| "failed" \| "running" \| "paused"; inputs: Record<string, unknown>; steps: Record<string, { status: "completed" \| "skipped" \| "pending" \| "failed" \| "running" \| "waiting"; sessionId?: string \| undefined; subagentId?: string \| undefined; result?: string \| undefined; error?: string \| undefined; startedAt?: number \| undefined; completedAt?: number \| undefined; }>; startedAt: number; coordinatorSessionId?: string \| undefined; currentStepId?: string \| undefined; completedAt?: number \| undefined; error?: string \| undefined; triggerPayload?: Record<string, unknown> \| undefined; }` | yes |

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

### <a id="storage:workflow.setSpan"></a>`storage:workflow.setSpan` (rpc)

Subject: `storage:workflow.setSpan`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `span` | `{ executionId: string; stepId: string; stepType: "agent" \| "shell" \| "gate"; status: "completed" \| "skipped" \| "failed" \| "running"; startedAt?: number \| undefined; completedAt?: number \| undefined; durationMs?: number \| undefined; inputTokens?: number \| undefined; outputTokens?: number \| undefined; estimatedCost?: number \| undefined; toolCallCount?: number \| undefined; input?: string \| undefined; output?: string \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `id` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

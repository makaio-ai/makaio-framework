---
title: "subagent"
editUrl: false
prev: false
next: false
---

# `subagent`

| Field | Value |
|-------|-------|
| Prefix | `subagent` |
| Namespace constant | `SubagentNamespace` |
| Subjects constant | `SubagentSubjects` |
| Kind | bus |
| Schema record | `SubagentSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/subagent/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/subagent/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `await` | [`subagent.await`](#subagent.await) | rpc | — |
| `cancelled` | [`subagent.cancelled`](#subagent.cancelled) | event | — |
| `completed` | [`subagent.completed`](#subagent.completed) | event | — |
| `completeTask` | [`subagent.completeTask`](#subagent.completeTask) | rpc | — |
| `execute` | [`subagent.execute`](#subagent.execute) | rpc | — |
| `executionFailed` | [`subagent.executionFailed`](#subagent.executionFailed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/subagent/schemas.ts) |
| `getStatus` | [`subagent.getStatus`](#subagent.getStatus) | rpc | — |
| `kill` | [`subagent.kill`](#subagent.kill) | rpc | — |
| `listBySession` | [`subagent.listBySession`](#subagent.listBySession) | rpc | — |
| `reportProgress` | [`subagent.reportProgress`](#subagent.reportProgress) | rpc | — |
| `requestInput` | [`subagent.requestInput`](#subagent.requestInput) | rpc | — |
| `send` | [`subagent.send`](#subagent.send) | rpc | — |
| `spawn` | [`subagent.spawn`](#subagent.spawn) | rpc | — |
| `spawned` | [`subagent.spawned`](#subagent.spawned) | event | — |
| `toChild` | [`subagent.toChild`](#subagent.toChild) | event | — |
| `toParent` | [`subagent.toParent`](#subagent.toParent) | event | — |

## Subject Details

### <a id="subagent.await"></a>`subagent.await` (rpc)

RPC: Await subagent completion or terminal state

Subject: `subagent.await`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `subagentId` | `string` | yes |
| `timeoutMs` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `pendingRequest` | `{ messageId: string; question: string; context?: string \| undefined; } \| undefined` | no |
| `result` | `string \| undefined` | no |
| `status` | `"completed" \| "cancelled" \| "failed" \| "waiting_input" \| "timeout"` | yes |

### <a id="subagent.cancelled"></a>`subagent.cancelled` (event)

Emitted when a subagent is cancelled by parent.
Subject: `subagent.cancelled`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `reason` | `string` | yes |
| `subagentId` | `string` | yes |

### <a id="subagent.completed"></a>`subagent.completed` (event)

Emitted when a subagent completes (success or failure).
Subject: `subagent.completed`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `result` | `string \| undefined` | no |
| `subagentId` | `string` | yes |
| `success` | `boolean` | yes |
| `usage` | `{ inputTokens: number; outputTokens: number; totalTokens: number; } \| undefined` | no |

### <a id="subagent.completeTask"></a>`subagent.completeTask` (rpc)

RPC: Child signals task completion

Subject: `subagent.completeTask`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `result` | `string` | yes |
| `subagentId` | `string` | yes |
| `summary` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `completed` | `boolean` | yes |

### <a id="subagent.execute"></a>`subagent.execute` (rpc)

RPC: Execute a spawned subagent (create session + start adapter)

Subject: `subagent.execute`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ task: string; adapterName?: string \| undefined; providerConfigId?: string \| undefined; providerContext?: { providerConfigId: string; definitionId: string; credentialRefs: Record<string, string>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; } \| undefined; harnessId?: string \| undefined; model?: string \| undefined; contextMode?: "fork" \| "fresh" \| undefined; tools?: string[] \| undefined; disallowedTools?: string[] \| undefined; systemPrompt?: string \| undefined; maxDepth?: number \| undefined; responseSchema?: Record<string, unknown> \| undefined; executionTargetId?: string \| undefined; }` | yes |
| `depth` | `number` | yes |
| `parentSessionId` | `string` | yes |
| `subagentId` | `string` | yes |
| `task` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="subagent.executionFailed"></a>`subagent.executionFailed` (event)

Event: Subagent execution failed during startup

Subject: `subagent.executionFailed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `error` | `string` | yes |
| `parentSessionId` | `string` | yes |
| `phase` | `"session_create" \| "adapter_start" \| "agent_start"` | yes |
| `subagentId` | `string` | yes |

### <a id="subagent.getStatus"></a>`subagent.getStatus` (rpc)

Query subagent status.
Subject: `subagent.getStatus`

Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `subagentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `pendingRequest` | `{ messageId: string; question: string; context?: string \| undefined; } \| undefined` | no |
| `progress` | `string[]` | yes |
| `result` | `string \| undefined` | no |
| `status` | `"completed" \| "cancelled" \| "failed" \| "spawning" \| "running" \| "waiting_input" \| "hung"` | yes |
| `summary` | `string \| undefined` | no |

### <a id="subagent.kill"></a>`subagent.kill` (rpc)

RPC: Kill a running subagent

Subject: `subagent.kill`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `reason` | `string \| undefined` | no |
| `subagentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `killed` | `boolean` | yes |

### <a id="subagent.listBySession"></a>`subagent.listBySession` (rpc)

RPC: List non-terminal subagents for a parent session.
Used by the coordinator manifest builder to populate `activeSubagents`.
Returns an empty array after process restart (in-memory tracking only).

Subject: `subagent.listBySession`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `parentSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `subagents` | `{ subagentId: string; task: string; status: "completed" \| "cancelled" \| "failed" \| "spawning" \| "running" \| "waiting_input" \| "hung"; }[]` | yes |

### <a id="subagent.reportProgress"></a>`subagent.reportProgress` (rpc)

RPC: Child reports progress

Subject: `subagent.reportProgress`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `percentComplete` | `number \| undefined` | no |
| `subagentId` | `string` | yes |
| `update` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `reported` | `boolean` | yes |

### <a id="subagent.requestInput"></a>`subagent.requestInput` (rpc)

RPC: Child requests input from parent

Subject: `subagent.requestInput`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `context` | `string \| undefined` | no |
| `question` | `string` | yes |
| `subagentId` | `string` | yes |
| `timeoutMs` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `responded` | `boolean` | yes |
| `response` | `string \| undefined` | no |
| `timedOut` | `boolean` | yes |

### <a id="subagent.send"></a>`subagent.send` (rpc)

RPC: Send message to subagent

Subject: `subagent.send`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `inResponseTo` | `string \| undefined` | no |
| `subagentId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `resolvedPending` | `boolean` | yes |
| `sent` | `boolean` | yes |

### <a id="subagent.spawn"></a>`subagent.spawn` (rpc)

RPC: Spawn a subagent (validates constraints, tracks, emits spawned)

Subject: `subagent.spawn`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ task: string; adapterName?: string \| undefined; providerConfigId?: string \| undefined; providerContext?: { providerConfigId: string; definitionId: string; credentialRefs: Record<string, string>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; } \| undefined; harnessId?: string \| undefined; model?: string \| undefined; contextMode?: "fork" \| "fresh" \| undefined; tools?: string[] \| undefined; disallowedTools?: string[] \| undefined; systemPrompt?: string \| undefined; maxDepth?: number \| undefined; responseSchema?: Record<string, unknown> \| undefined; executionTargetId?: string \| undefined; }` | yes |
| `depth` | `number` | yes |
| `parentSessionId` | `string` | yes |
| `spawningToolCallId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `status` | `"spawning"` | yes |
| `subagentId` | `string` | yes |

### <a id="subagent.spawned"></a>`subagent.spawned` (event)

Emitted when a subagent is spawned.
Subject: `subagent.spawned`

Note: childSessionId is not included - the session is created by
SubagentService after receiving this event, not pre-generated.

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `config` | `{ task: string; adapterName?: string \| undefined; providerConfigId?: string \| undefined; providerContext?: { providerConfigId: string; definitionId: string; credentialRefs: Record<string, string>; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; credentialEnvVars?: Record<string, string> \| undefined; ambientCredentialEnvVars?: string[] \| undefined; } \| undefined; harnessId?: string \| undefined; model?: string \| undefined; contextMode?: "fork" \| "fresh" \| undefined; tools?: string[] \| undefined; disallowedTools?: string[] \| undefined; systemPrompt?: string \| undefined; maxDepth?: number \| undefined; responseSchema?: Record<string, unknown> \| undefined; executionTargetId?: string \| undefined; }` | yes |
| `depth` | `number` | yes |
| `parentSessionId` | `string` | yes |
| `spawningToolCallId` | `string \| undefined` | no |
| `subagentId` | `string` | yes |
| `task` | `string` | yes |

### <a id="subagent.toChild"></a>`subagent.toChild` (event)

Message from parent to subagent.
Subject: `subagent.toChild`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `inResponseTo` | `string \| undefined` | no |
| `messageId` | `string` | yes |
| `subagentId` | `string` | yes |

### <a id="subagent.toParent"></a>`subagent.toParent` (event)

Message from subagent to parent.
Subject: `subagent.toParent`
Types: progress (status update), request_input (blocking question)

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `context` | `string \| undefined` | no |
| `messageId` | `string` | yes |
| `subagentId` | `string` | yes |
| `type` | `"progress" \| "request_input"` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

---
title: "session"
editUrl: false
prev: false
next: false
---

# `session`

| Field | Value |
|-------|-------|
| Prefix | `session` |
| Namespace constant | `SessionNamespace` |
| Subjects constant | `SessionSubjects` |
| Kind | bus |
| Schema record | `SessionSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`core/contracts/src/session/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `abandon` | [`session.abandon`](#session.abandon) | rpc | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `abandoned` | [`session.abandoned`](#session.abandoned) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `agent.added` | [`session.agent.added`](#session.agent.added) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `agent.attach` | [`session.agent.attach`](#session.agent.attach) | rpc | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `agent.removed` | [`session.agent.removed`](#session.agent.removed) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `archive` | [`session.archive`](#session.archive) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `archived` | [`session.archived`](#session.archived) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `branch.created` | [`session.branch.created`](#session.branch.created) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `branch.merged` | [`session.branch.merged`](#session.branch.merged) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `childCompleted` | [`session.childCompleted`](#session.childCompleted) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `clientAccount.changed` | [`session.clientAccount.changed`](#session.clientAccount.changed) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `close` | [`session.close`](#session.close) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `closed` | [`session.closed`](#session.closed) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `compress` | [`session.compress`](#session.compress) | rpc | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `compressed` | [`session.compressed`](#session.compressed) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `compressionRequested` | [`session.compressionRequested`](#session.compressionRequested) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `connectorSwap.editRequested` | [`session.connectorSwap.editRequested`](#session.connectorSwap.editRequested) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `create` | [`session.create`](#session.create) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `created` | [`session.created`](#session.created) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `enrichContext` | [`session.enrichContext`](#session.enrichContext) | rpc | [`enrichment.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/enrichment.ts) |
| `event` | [`session.event`](#session.event) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/event.ts) |
| `fork` | [`session.fork`](#session.fork) | rpc | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `forked` | [`session.forked`](#session.forked) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `forking` | [`session.forking`](#session.forking) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `get` | [`session.get`](#session.get) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `getByAdapterSessionId` | [`session.getByAdapterSessionId`](#session.getByAdapterSessionId) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `getChildren` | [`session.getChildren`](#session.getChildren) | rpc | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `getContextWindowState` | [`session.getContextWindowState`](#session.getContextWindowState) | rpc | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `getStatusCounts` | [`session.getStatusCounts`](#session.getStatusCounts) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `import.completed` | [`session.import.completed`](#session.import.completed) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `importStatusChanged` | [`session.importStatusChanged`](#session.importStatusChanged) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `list` | [`session.list`](#session.list) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `merge` | [`session.merge`](#session.merge) | rpc | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `merged` | [`session.merged`](#session.merged) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `merging` | [`session.merging`](#session.merging) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `purge` | [`session.purge`](#session.purge) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `purged` | [`session.purged`](#session.purged) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `resolveAgentConfig` | [`session.resolveAgentConfig`](#session.resolveAgentConfig) | rpc | [`resolve-agent-config.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/resolve-agent-config.ts) |
| `resolveSystemPrompt` | [`session.resolveSystemPrompt`](#session.resolveSystemPrompt) | rpc | [`resolve-system-prompt.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/resolve-system-prompt.ts) |
| `resume` | [`session.resume`](#session.resume) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `resumed` | [`session.resumed`](#session.resumed) | event | [`events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/events.ts) |
| `search` | [`session.search`](#session.search) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `sendMessage` | [`session.sendMessage`](#session.sendMessage) | rpc | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `snapshot.export` | [`session.snapshot.export`](#session.snapshot.export) | rpc | [`snapshot.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/snapshot.ts) |
| `snapshot.import` | [`session.snapshot.import`](#session.snapshot.import) | rpc | [`snapshot.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/snapshot.ts) |
| `snapshot.validate` | [`session.snapshot.validate`](#session.snapshot.validate) | rpc | [`snapshot.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/snapshot.ts) |
| `squash` | [`session.squash`](#session.squash) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `turn.completed` | [`session.turn.completed`](#session.turn.completed) | event | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `turn.started` | [`session.turn.started`](#session.turn.started) | event | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `update` | [`session.update`](#session.update) | rpc | [`crud.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/crud.ts) |
| `updated` | [`session.updated`](#session.updated) | event | [`lifecycle-events.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/lifecycle-events.ts) |
| `usage` | [`session.usage`](#session.usage) | rpc | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `user_message.acknowledged` | [`session.user_message.acknowledged`](#session.user_message.acknowledged) | event | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `user_message.completed` | [`session.user_message.completed`](#session.user_message.completed) | event | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |
| `user_message.sent` | [`session.user_message.sent`](#session.user_message.sent) | event | [`orchestrator.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/session/schemas/orchestrator.ts) |

## Subject Details

### <a id="session.abandon"></a>`session.abandon` (rpc)

Abandon a child session without merging.
Subject: `session.abandon`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `extensionId` | `string \| undefined` | no |
| `parentSessionId` | `string` | yes |
| `source` | `"user" \| "system" \| "extension" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="session.abandoned"></a>`session.abandoned` (event)

Emitted when session is abandoned.
Subject: `session.abandoned`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `parentSessionId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

### <a id="session.agent.added"></a>`session.agent.added` (event)

Agent added to session event.

Subject: `session.agent.added`
Type: Event (fire-and-forget)
Emitted when: An agent is attached to a session

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `cwd` | `string \| undefined` | no |
| `model` | `string \| undefined` | no |
| `role` | `"lead" \| "member" \| undefined` | no |
| `sessionId` | `string` | yes |

### <a id="session.agent.attach"></a>`session.agent.attach` (rpc)

Explicitly attach an agent to a session.

Subject: `session.agent.attach`
Type: Request (RPC)

Unlike auto-attach via sendMessage, this RPC provides explicit control over:
- Agent role (lead vs member)
- Attaching without sending a message

For branching conversations (fork), use `session.fork` to create a new session
with copied history, then attach agents to the new session.

Use this for multi-agent scenarios or when you need to pre-attach agents
before sending messages.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ [x: string]: unknown; kind: string; providerConfigId?: string \| undefined; model?: string \| undefined; reasoningEffort?: "none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined; cwd?: string \| undefined; systemPrompt?: string \| { mode: "append"; content: string; } \| undefined; allowedTools?: string[] \| undefined; disallowedTools?: string[] \| undefined; env?: Record<string, string> \| undefined; mcpSessionContext?: { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined; allowedDirectories?: string[] \| undefined; }` | yes |
| `initialMessage` | `string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; } \| undefined` | no |
| `role` | `"lead" \| "member" \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |
| `agentId` | `string` | yes |
| `messageId` | `string \| undefined` | no |
| `role` | `"lead" \| "member"` | yes |
| `turnId` | `string \| undefined` | no |

### <a id="session.agent.removed"></a>`session.agent.removed` (event)

Agent removed from session event.

Subject: `session.agent.removed`
Type: Event (fire-and-forget)
Emitted when: An agent is detached/removed from a session

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `sessionId` | `string` | yes |

### <a id="session.archive"></a>`session.archive` (rpc)

Archive a closed session.

Subject: `session.archive`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="session.archived"></a>`session.archived` (event)

Session archived event.

Subject: `session.archived`
Type: Event (fire-and-forget)
Emitted when: A closed session is archived

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

### <a id="session.branch.created"></a>`session.branch.created` (event)

Branch created event (for storage/persistence via SessionLogger).
Subject: `session.branch.created`
Type: Event (fire-and-forget)

Emitted by fork handler. SessionLogger subscribes and persists
with transform applied (e.g., PII redaction).

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `forkPointMessageId` | `string \| undefined` | no |
| `kind` | `"fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"` | yes |
| `parentSessionId` | `string` | yes |
| `sessionId` | `string` | yes |
| `transforms` | `{ removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined` | no |

### <a id="session.branch.merged"></a>`session.branch.merged` (event)

Branch merged event (for storage/persistence via SessionLogger).
Subject: `session.branch.merged`
Type: Event (fire-and-forget)

Emitted by merge handler. SessionLogger subscribes and persists
with transform applied.

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `parentSessionId` | `string` | yes |
| `resultJson` | `string \| undefined` | no |
| `resultMessageId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

### <a id="session.childCompleted"></a>`session.childCompleted` (event)

Emitted when a child session completes.
Subject: `session.childCompleted`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `parentSessionId` | `string` | yes |
| `result` | `unknown` | yes |

### <a id="session.clientAccount.changed"></a>`session.clientAccount.changed` (event)

Session client-account linkage changed event.

Subject: `session.clientAccount.changed`
Type: Event (fire-and-forget)
Emitted when: A session resolves to a different canonical client account

| Field | Type | Required |
|-------|------|----------|
| `clientAccountId` | `string` | yes |
| `clientId` | `string` | yes |
| `lastClientIdentityObservation` | `{ clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; }` | yes |
| `observedAt` | `number` | yes |
| `previousClientAccountId` | `string \| null` | yes |
| `sessionId` | `string` | yes |
| `source` | `string` | yes |

### <a id="session.close"></a>`session.close` (rpc)

Close an existing session.

Subject: `session.close`
Type: Request (RPC)

Closing a session marks it as inactive but retains session data and events
for potential resume. Use `purge` to permanently delete all data.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="session.closed"></a>`session.closed` (event)

Session closed event.

Subject: `session.closed`
Type: Event (fire-and-forget)
Emitted when: A session is closed (via close request)

| Field | Type | Required |
|-------|------|----------|
| `reason` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

### <a id="session.compress"></a>`session.compress` (rpc)

Compress session context via pipeline.
Subject: `session.compress`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `pipeline` | `{ actionId: string; options?: Record<string, unknown> \| undefined; }[]` | yes |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `contextJson` | `Record<string, unknown>` | yes |
| `eventId` | `string` | yes |
| `tokensAfter` | `number \| undefined` | no |
| `tokensBefore` | `number` | yes |

### <a id="session.compressed"></a>`session.compressed` (event)

Session compressed event.

Subject: `session.compressed`
Type: Event (fire-and-forget)
Emitted when: A session's context is compressed (via compress request)

Used to notify components (like ContextWindowTracker) that context state
should be cleared since compression resets the context window.

| Field | Type | Required |
|-------|------|----------|
| `eventId` | `string` | yes |
| `sessionId` | `string` | yes |

### <a id="session.compressionRequested"></a>`session.compressionRequested` (event)

Compression requested for a session.
Subject: `session.compressionRequested`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `extensionId` | `string \| undefined` | no |
| `reason` | `string` | yes |
| `sessionId` | `string` | yes |
| `source` | `"user" \| "system" \| "extension" \| undefined` | no |

### <a id="session.connectorSwap.editRequested"></a>`session.connectorSwap.editRequested` (event)

Request UI to open history editing flow after a connector swap decision.

Subject: `session.connectorSwap.editRequested`
Type: Event (fire-and-forget)

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `newCwd` | `string \| undefined` | no |
| `newModel` | `string \| undefined` | no |
| `previousCwd` | `string \| undefined` | no |
| `previousModel` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

### <a id="session.create"></a>`session.create` (rpc)

Create a new makaio session.

Subject: `session.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branchKind` | `"fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined` | no |
| `contextInheritance` | `"none" \| "parent-history" \| undefined` | no |
| `executionTargetId` | `string \| undefined` | no |
| `forkPointMessageId` | `string \| undefined` | no |
| `forkTransforms` | `{ removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined` | no |
| `originWindowId` | `string \| undefined` | no |
| `parentSessionId` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `spawningToolCallId` | `string \| undefined` | no |
| `targetWorkingDirectory` | `string \| undefined` | no |
| `title` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

### <a id="session.created"></a>`session.created` (event)

Session created event (for storage/persistence via SessionLogger).
Subject: `session.created`
Type: Event (fire-and-forget)

Emitted when a new session is created. SessionLogger subscribes and
persists with transform applied.

| Field | Type | Required |
|-------|------|----------|
| `branchKind` | `"fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| null` | yes |
| `createdAt` | `number` | yes |
| `originWindowId` | `string \| undefined` | no |
| `parentSessionId` | `string \| null` | yes |
| `sessionId` | `string` | yes |

### <a id="session.enrichContext"></a>`session.enrichContext` (rpc)

Enrich session hook context with optional host-owned fields.

Subject: `session.enrichContext`
Type: Request (RPC, optional)

Framework code calls `bus.requestOptional(SessionSubjects.enrichContext, { sessionId })`
inside `fetchSessionEnrichment`. Host registers a handler that returns
arbitrary key/value context extensions (e.g., `project`, `worktree`).
When no handler is registered, `requestOptional` returns `{ handled: false }`
and the hook context carries only framework-owned fields.

Host adds TypeScript visibility via declaration merging on
`SessionHookContext` in `@makaio/hooks`.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

### <a id="session.event"></a>`session.event` (event)

Catch-all session event for observability and persistence.

Subject: `session.event`
Type: Event (fire-and-forget)
Use for: Single subscription to all session events, event storage

| Field | Type | Required |
|-------|------|----------|
| `eventId` | `string` | yes |
| `payload` | `Record<string, unknown> \| { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; } \| { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; } \| { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; } \| { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; } \| { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; } \| { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; } \| { messageId: string; turnId: string \| null; role: "user" \| "assistant"; } \| { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; } \| { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; } \| { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }` | yes |
| `sessionId` | `string` | yes |
| `timestamp` | `number` | yes |
| `type` | `string` | yes |

### <a id="session.fork"></a>`session.fork` (rpc)

Fork a session to create a branch point in conversation history.

Subject: `session.fork`
Type: Request (RPC)

Creates a new session that references the parent via parentSessionId
and forkPointMessageId. NO message copying occurs - full conversation
is assembled via getFullConversation() which traverses the parent chain.

The forked session starts with no agents - use agent.attach to add agents.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branchKind` | `"fork" \| "branch" \| "aside" \| undefined` | no |
| `existingSessionId` | `string \| undefined` | no |
| `fromMessageId` | `string \| undefined` | no |
| `name` | `string \| undefined` | no |
| `sourceSessionId` | `string` | yes |
| `targetWorkingDirectory` | `string \| undefined` | no |
| `transforms` | `{ removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

### <a id="session.forked"></a>`session.forked` (event)

Emitted after fork completes.
Subject: `session.forked`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `forkPoint` | `string \| undefined` | no |
| `parentSessionId` | `string` | yes |

### <a id="session.forking"></a>`session.forking` (event)

Emitted when fork is about to happen.
Subject: `session.forking`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `parentSessionId` | `string` | yes |
| `reason` | `string` | yes |

### <a id="session.get"></a>`session.get` (rpc)

Get a specific session by ID.

Subject: `session.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; } \| null` | yes |

### <a id="session.getByAdapterSessionId"></a>`session.getByAdapterSessionId` (rpc)

Get a session by its adapter session ID.

Subject: `session.getByAdapterSessionId`
Type: Request (RPC)

Used by log import to check if a session already exists for a given
external session identifier (e.g., Claude Code session ID).

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `session` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; } \| null` | yes |

### <a id="session.getChildren"></a>`session.getChildren` (rpc)

Get child sessions of a parent.
Subject: `session.getChildren`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `children` | `{ sessionId: string; title: string \| null; forkPointMessageId: string \| null; branchKind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| null; messageCount: number; hasChildren: boolean; spawningToolCallId?: string \| undefined; }[]` | yes |

### <a id="session.getContextWindowState"></a>`session.getContextWindowState` (rpc)

Get context window state for a session.

Subject: `session.getContextWindowState`
Type: Request (RPC)

Returns the current context window usage for a session, aggregated
across all agents (using "worst agent" strategy).

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `state` | `{ currentTokens: number; maxTokens: number; percentage: number; level: "warn" \| "ok" \| "critical"; lastUpdatedAt: number; } \| null` | yes |

### <a id="session.getStatusCounts"></a>`session.getStatusCounts` (rpc)

Get session counts by status for filter UI.

Subject: `session.getStatusCounts`
Type: Request (RPC)

Returns counts for all statuses in a single efficient query.
Useful for status filter UI badges that show totals regardless of current filter.

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

### <a id="session.import.completed"></a>`session.import.completed` (event)

Imported session completed event.

Subject: `session.import.completed`
Type: Event (fire-and-forget)
Emitted when: An imported session finishes its import cycle and its
Makaio session record is fully populated (importStatus transitions
to 'imported'). Used by resolvers that need to perform post-import
lineage resolution (parent, compress-lineage).

| Field | Type | Required |
|-------|------|----------|
| `adapterSessionId` | `string` | yes |
| `sessionId` | `string` | yes |
| `source` | `string` | yes |

### <a id="session.importStatusChanged"></a>`session.importStatusChanged` (event)

Import status of a session changed.

Subject: `session.importStatusChanged`
Type: Event (fire-and-forget)
Emitted when: An imported session's `importStatus` column transitions
(e.g., discovered → imported, discovered → tracking).

Used by the entity cache to keep imported-session state reactive in the UI.
Emitted by the storage layer as the canonical import-status event.

| Field | Type | Required |
|-------|------|----------|
| `importStatus` | `"discovered" \| "imported" \| "tracking"` | yes |
| `sessionId` | `string` | yes |

### <a id="session.list"></a>`session.list` (rpc)

List makaio sessions.

Subject: `session.list`
Type: Request (RPC)

When `includePreview: true`, each session includes a `preview` object
with `messageCount` and `firstUserMessage` for UI display.

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
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; preview?: { messageCount: number; firstUserMessage: string \| null; } \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="session.merge"></a>`session.merge` (rpc)

Merge a child session into parent.
Subject: `session.merge`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `extensionId` | `string \| undefined` | no |
| `parentSessionId` | `string` | yes |
| `source` | `"user" \| "system" \| "extension" \| undefined` | no |
| `summary` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `handoff` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="session.merged"></a>`session.merged` (event)

Emitted after merge completes.
Subject: `session.merged`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `handoff` | `string` | yes |
| `parentSessionId` | `string` | yes |

### <a id="session.merging"></a>`session.merging` (event)

Emitted when merge is about to happen.
Subject: `session.merging`

Type: Event

| Field | Type | Required |
|-------|------|----------|
| `childSessionId` | `string` | yes |
| `parentSessionId` | `string` | yes |

### <a id="session.purge"></a>`session.purge` (rpc)

Permanently delete a session and all its events.

Subject: `session.purge`
Type: Request (RPC)

Unlike `close`, this permanently removes all session data including
event history. Use when session data is no longer needed (e.g., user
explicitly deletes conversation, data retention policy).

**Requires session to be archived first.** This ensures no agents are still
emitting events that would race with deletion.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `eventsDeleted` | `number \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="session.purged"></a>`session.purged` (event)

Session purged event.

Subject: `session.purged`
Type: Event (fire-and-forget)
Emitted when: A session is permanently deleted (via purge request)

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

### <a id="session.resolveAgentConfig"></a>`session.resolveAgentConfig` (rpc)

Resolve the concrete adapter configuration for a given agent selection.

Subject: `session.resolveAgentConfig`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `projectId` | `string \| undefined` | no |
| `selection` | `{ [x: string]: unknown; kind: string; providerConfigId?: string \| undefined; model?: string \| undefined; reasoningEffort?: "none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined; cwd?: string \| undefined; systemPrompt?: string \| { mode: "append"; content: string; } \| undefined; allowedTools?: string[] \| undefined; disallowedTools?: string[] \| undefined; env?: Record<string, string> \| undefined; mcpSessionContext?: { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined; allowedDirectories?: string[] \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `adapterName` | `string` | yes |
| `allowedDirectories` | `string[] \| undefined` | no |
| `allowedTools` | `string[] \| undefined` | no |
| `disallowedTools` | `string[] \| undefined` | no |
| `model` | `string \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `reasoningEffort` | `"none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined` | no |
| `supportedReasoningLevels` | `{ none?: string \| number \| undefined; low?: string \| number \| undefined; medium?: string \| number \| undefined; high?: string \| number \| undefined; 'extra-high'?: string \| number \| undefined; } \| undefined` | no |
| `systemPrompt` | `string \| { mode: "append"; content: string; } \| undefined` | no |

### <a id="session.resolveSystemPrompt"></a>`session.resolveSystemPrompt` (rpc)

Resolve the fully-assembled system prompt for a given session.

Subject: `session.resolveSystemPrompt`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `personaId` | `string \| undefined` | no |
| `profileId` | `string \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `personaName` | `string \| undefined` | no |
| `profileName` | `string \| undefined` | no |
| `systemPrompt` | `string` | yes |

### <a id="session.resume"></a>`session.resume` (rpc)

Resume a closed session back to active.

Subject: `session.resume`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="session.resumed"></a>`session.resumed` (event)

Session resumed event.

Subject: `session.resumed`
Type: Event (fire-and-forget)
Emitted when: A closed session is resumed to active state

| Field | Type | Required |
|-------|------|----------|
| `sessionId` | `string` | yes |

### <a id="session.search"></a>`session.search` (rpc)

Search sessions by content using FTS5 full-text search.

Subject: `session.search`
Type: Request (RPC)

Searches across session message content. Always includes preview data
since search is content-focused.

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
| `sessions` | `{ sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; preview?: { messageCount: number; firstUserMessage: string \| null; } \| undefined; }[]` | yes |
| `total` | `number` | yes |

### <a id="session.sendMessage"></a>`session.sendMessage` (rpc)

Send a message to a session's agents.

Subject: `session.sendMessage`
Type: Request (RPC)

Single entry point for all user messages. Handles:
- Creating session if sessionId does not exist
- Auto-attaching agent via adapter.startAgent if session has no agents
- Turn lifecycle (creates turn if none active)
- Routing to targeted agents

Default targets lead agent; use `agentIds: 'all'` for broadcast.

`responseSchema.schema` is a JSON Schema document serialized as a
JSON-safe `Record<string, JsonValue>` so it can cross bus, storage, and
provider adapter boundaries without runtime-only values.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `agent` | `{ [x: string]: unknown; kind: "adapter"; providerConfigId?: string \| undefined; model?: string \| undefined; reasoningEffort?: "none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined; cwd?: string \| undefined; systemPrompt?: string \| { mode: "append"; content: string; } \| undefined; allowedTools?: string[] \| undefined; disallowedTools?: string[] \| undefined; env?: Record<string, string> \| undefined; mcpSessionContext?: { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined; allowedDirectories?: string[] \| undefined; adapterName?: string \| undefined; adapterId?: string \| undefined; } \| { [x: string]: unknown; kind: "canonical-model"; model: string; providerConfigId?: string \| undefined; reasoningEffort?: "none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined; cwd?: string \| undefined; systemPrompt?: string \| { mode: "append"; content: string; } \| undefined; allowedTools?: string[] \| undefined; disallowedTools?: string[] \| undefined; env?: Record<string, string> \| undefined; mcpSessionContext?: { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined; allowedDirectories?: string[] \| undefined; } \| { [x: string]: unknown; kind: string; providerConfigId?: string \| undefined; model?: string \| undefined; reasoningEffort?: "none" \| "low" \| "medium" \| "high" \| "extra-high" \| undefined; cwd?: string \| undefined; systemPrompt?: string \| { mode: "append"; content: string; } \| undefined; allowedTools?: string[] \| undefined; disallowedTools?: string[] \| undefined; env?: Record<string, string> \| undefined; mcpSessionContext?: { sessionId: string; servers: { name: string; transport: { type: "stdio"; command: string; args?: string[] \| undefined; env?: Record<string, string> \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "sse"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; } \| { url: string; type: "http"; headers?: Record<string, string> \| undefined; tools?: { name: string; permission_policy: "always_allow" \| "always_ask" \| "always_deny"; }[] \| undefined; alwaysLoad?: boolean \| undefined; }; exposureMode: "direct" \| "discovery"; }[]; directTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; discoverableTools: { fullName: string; originalName: string; serverName: string; inputSchema: Record<string, unknown>; exposureMode: "direct" \| "discovery" \| "hidden"; enabled: boolean; exposed: boolean; description?: string \| undefined; enabledBy?: "discovery" \| "toolset" \| undefined; enabledAt?: number \| undefined; }[]; } \| undefined; allowedDirectories?: string[] \| undefined; } \| undefined` | no |
| `agentIds` | `"all" \| string[] \| undefined` | no |
| `deliveryMode` | `"enqueue" \| undefined` | no |
| `extensionId` | `string \| undefined` | no |
| `message` | `string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }` | yes |
| `origin` | `"text" \| "voice" \| "compact" \| undefined` | no |
| `originWindowId` | `string \| undefined` | no |
| `responseSchema` | `{ schema: Record<string, JsonValue>; name?: string \| undefined; strict?: boolean \| undefined; } \| undefined` | no |
| `sessionContext` | `{ messageHistory?: { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }[] \| undefined; hasNewTransforms?: boolean \| undefined; hasCompression?: boolean \| undefined; extractedContext?: unknown; isFirstTurn?: boolean \| undefined; hasConnectorSwap?: boolean \| undefined; turnContext?: Record<string, unknown> \| undefined; } \| undefined` | no |
| `sessionId` | `string` | yes |
| `skipConnectorSwapWarning` | `boolean \| undefined` | no |
| `source` | `"user" \| "system" \| "extension" \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `messageId` | `string` | yes |
| `sessionId` | `string` | yes |
| `turnId` | `string` | yes |

### <a id="session.snapshot.export"></a>`session.snapshot.export` (rpc)

Export a session to a snapshot file.

Subject: `session.snapshot.export`
Type: Request (RPC)

Creates a snapshot file containing session data for backup or transfer.
Supports filtering what data to include via export options.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `options` | `{ includeEvents?: boolean \| undefined; includeToolOutputs?: boolean \| undefined; includeAncestors?: boolean \| undefined; includeChildren?: boolean \| undefined; } \| undefined` | no |
| `sessionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `snapshot` | `{ version: "1.0"; exportedAt: number; options: { includeEvents: boolean; includeToolOutputs: boolean; includeAncestors: boolean; includeChildren: boolean; }; sessions: { sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; }[]; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; messages: { messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }[]; turns: { turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }[]; events?: ({ sessionId: string; eventId: string; timestamp: number; type: "agent.added"; payload: { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.sent"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.acknowledged"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.started"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "message"; payload: { messageId: string; turnId: string \| null; role: "user" \| "assistant"; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.created"; payload: { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.merged"; payload: { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "squash"; payload: { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: string; payload: Record<string, unknown>; })[] \| undefined; }` | yes |

### <a id="session.snapshot.import"></a>`session.snapshot.import` (rpc)

Import sessions from a snapshot file.

Subject: `session.snapshot.import`
Type: Request (RPC)

Imports session data from a snapshot file, with conflict resolution
options for handling existing sessions.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `onConflict` | `"overwrite" \| "fail" \| "skip" \| undefined` | no |
| `snapshot` | `{ version: "1.0"; exportedAt: number; options: { includeEvents?: boolean \| undefined; includeToolOutputs?: boolean \| undefined; includeAncestors?: boolean \| undefined; includeChildren?: boolean \| undefined; }; sessions: { sessionId: string; createdAt: number; lastActivityAt: number; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; status: "active" \| "archived" \| "closed" \| "discovered"; leadAgentId?: string \| undefined; parentSessionId?: string \| undefined; contextInheritance?: "none" \| "parent-history" \| undefined; rootSessionId?: string \| undefined; forkPointMessageId?: string \| undefined; branchKind?: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside" \| undefined; adapterName?: string \| undefined; adapterSessionId?: string \| undefined; adapterId?: string \| undefined; clientId?: string \| undefined; clientAccountId?: string \| undefined; lastClientIdentityObservation?: { clientId: string; source: string; kind: string; observedAt: number; payload: Record<string, unknown>; } \| undefined; isOrchestrated?: boolean \| undefined; title?: string \| undefined; summary?: string \| undefined; summaryUpdatedAt?: number \| undefined; isImported?: boolean \| undefined; forkTransforms?: { removedMessageIds?: string[] \| undefined; appliedPipeline?: { actionId: string; options?: Record<string, unknown> \| undefined; }[] \| undefined; segments?: { fromMessageId: string; toMessageId: string; policy: "verbatim" \| "summarize" \| "exclude"; stripReasoning?: boolean \| undefined; stripToolOutputs?: boolean \| undefined; overrides?: Record<string, "exclude"> \| undefined; summaryText?: string \| undefined; }[] \| undefined; } \| undefined; targetWorkingDirectory?: string \| undefined; executionTargetId?: string \| undefined; spawningToolCallId?: string \| undefined; approvalPolicyOverride?: "reject" \| "always-ask" \| "full-access" \| null \| undefined; source?: string \| undefined; parentExternalSessionId?: string \| undefined; logFilePath?: string \| undefined; discoveredAt?: number \| undefined; importStatus?: "discovered" \| "imported" \| "tracking" \| undefined; }[]; agents: { agentId: string; adapterId: string; adapterName: string; sessionId: string; role: "lead" \| "member"; status: "active" \| "idle" \| "dead" \| "disposed"; createdAt: number; lastActivityAt: number; adapterSessionId?: string \| undefined; model?: string \| undefined; cwd?: string \| undefined; providerConfigId?: string \| undefined; personaId?: string \| undefined; profileId?: string \| undefined; harnessId?: string \| undefined; clientId?: string \| undefined; compressionMode?: "manual" \| "auto" \| "off" \| undefined; }[]; messages: { messageId: string; turnId: string \| null; sessionId: string; role: "user" \| "assistant"; contentText: string; blocks: ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; timestamp: number; agentId?: string \| undefined; adapterSessionId?: string \| undefined; adapterMessageId?: string \| undefined; editOf?: string \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }[]; turns: { turnId: string; sessionId: string; turnNumber: number; startedAt: number; status: "error" \| "active" \| "completed"; completedAt?: number \| undefined; error?: string \| undefined; usage?: { total: { inputTokens: number; outputTokens: number; cost?: number \| undefined; }; byAgent?: Record<string, { inputTokens: number; outputTokens: number; cost?: number \| undefined; }> \| undefined; } \| undefined; }[]; events?: ({ sessionId: string; eventId: string; timestamp: number; type: "agent.added"; payload: { sessionId: string; adapterSessionId: string; agentId: string; adapterId: string; adapterName: string; role?: "lead" \| "member" \| undefined; model?: string \| undefined; cwd?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.sent"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; content: string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }; agentIds: string[]; source?: "user" \| "system" \| "extension" \| undefined; origin?: "text" \| "voice" \| "compact" \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.acknowledged"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "user_message.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentId: string; outcome: "error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"; supersededBy?: string \| undefined; mergedInto?: string \| undefined; error?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.started"; payload: { sessionId: string; turnId: string; turnNumber: number; messageId: string; agentIds: string[]; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "turn.completed"; payload: { sessionId: string; turnId: string; turnNumber: number; success: boolean; error?: string \| undefined; initiator?: { source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "message"; payload: { messageId: string; turnId: string \| null; role: "user" \| "assistant"; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.created"; payload: { childSessionId: string; parentSessionId: string; kind: "fork" \| "subagent" \| "compress" \| "branch" \| "rewrite" \| "coordinator" \| "aside"; forkPointMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "branch.merged"; payload: { childSessionId: string; parentSessionId: string; resultJson?: string \| undefined; resultMessageId?: string \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: "squash"; payload: { summaryJson: string; tokensBefore?: number \| undefined; tokensAfter?: number \| undefined; compressedMessageIds?: string[] \| undefined; }; } \| { sessionId: string; eventId: string; timestamp: number; type: string; payload: Record<string, unknown>; })[] \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `errors` | `{ sessionId: string; error: string; }[]` | yes |
| `imported` | `string[]` | yes |
| `skipped` | `string[]` | yes |

### <a id="session.snapshot.validate"></a>`session.snapshot.validate` (rpc)

Validate a snapshot object against the schema.

Subject: `session.snapshot.validate`
Type: Request (RPC)

Validates a snapshot object without importing it. Useful for
checking snapshot files before import.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `snapshot` | `unknown` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `errors` | `string[]` | yes |
| `valid` | `boolean` | yes |

### <a id="session.squash"></a>`session.squash` (event)

Context squash event (for storage/persistence via SessionLogger).
Subject: `session.squash`
Type: Event (fire-and-forget)

Emitted when context is compressed. SessionLogger subscribes and
persists with transform applied.

| Field | Type | Required |
|-------|------|----------|
| `compressedMessageIds` | `string[] \| undefined` | no |
| `sessionId` | `string` | yes |
| `summaryJson` | `string` | yes |
| `tokensAfter` | `number \| undefined` | no |
| `tokensBefore` | `number \| undefined` | no |

### <a id="session.turn.completed"></a>`session.turn.completed` (event)

Turn completed.

Subject: `session.turn.completed`
Type: Event (fire-and-forget)
Emitted when: All targeted agents have completed processing

Semantics:
- success=true: all agents completed with outcome='completed'
- success=false: any agent had outcome='error'
- cancelled/superseded/merged outcomes are neutral (not errors)

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `initiator` | `{ source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined` | no |
| `sessionId` | `string` | yes |
| `success` | `boolean` | yes |
| `turnId` | `string` | yes |
| `turnNumber` | `number` | yes |

### <a id="session.turn.started"></a>`session.turn.started` (event)

Turn started.

Subject: `session.turn.started`
Type: Event (fire-and-forget)
Emitted when: First user message of a turn is received

| Field | Type | Required |
|-------|------|----------|
| `agentIds` | `string[]` | yes |
| `initiator` | `{ source: "user" \| "system" \| "extension"; sourceId?: string \| undefined; } \| undefined` | no |
| `messageId` | `string` | yes |
| `sessionId` | `string` | yes |
| `turnId` | `string` | yes |
| `turnNumber` | `number` | yes |

### <a id="session.update"></a>`session.update` (rpc)

Update specific session fields (partial update).

Subject: `session.update`
Type: Request (RPC)

Unlike re-setting the entire session, this performs a targeted update
of specific fields.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `approvalPolicyOverride` | `"reject" \| "always-ask" \| "full-access" \| null \| undefined` | no |
| `executionTargetId` | `string \| null \| undefined` | no |
| `sessionId` | `string` | yes |
| `title` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="session.updated"></a>`session.updated` (event)

Session property updated event.
Subject: `session.updated`
Type: Event (fire-and-forget)

Emitted after a session update (e.g., title, status change).
Entity cache subscribes to re-fetch updated session data.

| Field | Type | Required |
|-------|------|----------|
| `changedProperties` | `string[]` | yes |
| `sessionId` | `string` | yes |

### <a id="session.usage"></a>`session.usage` (rpc)

Aggregated session-level token usage.

Subject: `session.usage`
Type: Event (fire-and-forget)
Emitted when: UsageAggregator receives adapter.session.usage events

Aggregates token usage across all adapters in a session.
UsageAggregator listens to adapter.session.usage events, aggregates them
per-session (keyed by adapterSessionId to avoid collisions), and emits
this canonical session-level usage event.

ContextTracker consumes this to track context window usage against thresholds.

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterCount` | `number` | yes |
| `sessionId` | `string` | yes |
| `totalCalls` | `number` | yes |
| `totalInputTokens` | `number` | yes |
| `totalOutputTokens` | `number` | yes |
| `totalTokens` | `number` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `acknowledged` | `true` | yes |

### <a id="session.user_message.acknowledged"></a>`session.user_message.acknowledged` (event)

User message acknowledged by agent.

Subject: `session.user_message.acknowledged`
Type: Event (fire-and-forget)
Emitted when: An agent receives and begins processing the message

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `messageId` | `string` | yes |
| `sessionId` | `string` | yes |
| `turnId` | `string` | yes |
| `turnNumber` | `number` | yes |

### <a id="session.user_message.completed"></a>`session.user_message.completed` (event)

User message processing completed by agent.

Subject: `session.user_message.completed`
Type: Event (fire-and-forget)
Emitted when: An agent finishes processing the message

| Field | Type | Required |
|-------|------|----------|
| `agentId` | `string` | yes |
| `error` | `string \| undefined` | no |
| `mergedInto` | `string \| undefined` | no |
| `messageId` | `string` | yes |
| `outcome` | `"error" \| "completed" \| "superseded" \| "merged" \| "cancelled" \| "rejected"` | yes |
| `sessionId` | `string` | yes |
| `supersededBy` | `string \| undefined` | no |
| `turnId` | `string` | yes |
| `turnNumber` | `number` | yes |

### <a id="session.user_message.sent"></a>`session.user_message.sent` (event)

User message sent to session.

Subject: `session.user_message.sent`
Type: Event (fire-and-forget)
Emitted when: User sends a message (before routing to agents)

| Field | Type | Required |
|-------|------|----------|
| `agentIds` | `string[]` | yes |
| `content` | `string \| { blocks: { type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; } \| ({ type: "text"; content: string; } \| { type: "image"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "document"; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; } \| { type: "attachment"; fileName: string; filePath: string; source: { type: "base64"; data: string; mimeType: string; } \| { type: "url"; url: string; mimeType?: string \| undefined; }; attachmentType: "file" \| "directory"; displayName?: string \| undefined; } \| { type: "reasoning"; content: string; metadata?: Record<string, unknown> \| undefined; } \| { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; } \| { type: "tool_output"; toolCallId: string; output: string; isError?: boolean \| undefined; })[]; role?: "user" \| "assistant" \| "system" \| undefined; }` | yes |
| `messageId` | `string` | yes |
| `origin` | `"text" \| "voice" \| "compact" \| undefined` | no |
| `sessionId` | `string` | yes |
| `source` | `"user" \| "system" \| "extension" \| undefined` | no |
| `turnId` | `string` | yes |
| `turnNumber` | `number` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

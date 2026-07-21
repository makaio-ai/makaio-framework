---
title: "adapter:github-copilot"
editUrl: false
prev: false
next: false
---

# `adapter:github-copilot`

| Field | Value |
|-------|-------|
| Prefix | `adapter:github-copilot` |
| Namespace constant | `GitHubCopilotConnectorNamespace` |
| Subjects constant | `GitHubCopilotConnectorSubjects` |
| Kind | adapter |
| Schema record | `<inline>` |
| Tier | framework |
| Package | `@makaio/adapter-github-copilot-sdk` |
| Defined in | [`adapters/implementations/github-copilot-sdk/src/namespaces/index.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/github-copilot-sdk/src/namespaces/index.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `abort` | [`adapter:github-copilot.abort`](#adapter:github-copilot.abort) | event | — |
| `assistant.message` | [`adapter:github-copilot.assistant.message`](#adapter:github-copilot.assistant.message) | event | — |
| `assistant.reasoning` | [`adapter:github-copilot.assistant.reasoning`](#adapter:github-copilot.assistant.reasoning) | event | — |
| `assistant.reasoning_delta` | [`adapter:github-copilot.assistant.reasoning_delta`](#adapter:github-copilot.assistant.reasoning_delta) | event | — |
| `assistant.turn_end` | [`adapter:github-copilot.assistant.turn_end`](#adapter:github-copilot.assistant.turn_end) | event | — |
| `assistant.turn_start` | [`adapter:github-copilot.assistant.turn_start`](#adapter:github-copilot.assistant.turn_start) | event | — |
| `assistant.usage` | [`adapter:github-copilot.assistant.usage`](#adapter:github-copilot.assistant.usage) | event | — |
| `can_use_tool` | [`adapter:github-copilot.can_use_tool`](#adapter:github-copilot.can_use_tool) | rpc | [`tool-approval.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/core/src/utils/tool-approval.ts) |
| `hook.end` | [`adapter:github-copilot.hook.end`](#adapter:github-copilot.hook.end) | event | — |
| `hook.start` | [`adapter:github-copilot.hook.start`](#adapter:github-copilot.hook.start) | event | — |
| `sdk.event` | [`adapter:github-copilot.sdk.event`](#adapter:github-copilot.sdk.event) | event | — |
| `session.error` | [`adapter:github-copilot.session.error`](#adapter:github-copilot.session.error) | event | — |
| `session.idle` | [`adapter:github-copilot.session.idle`](#adapter:github-copilot.session.idle) | event | — |
| `session.info` | [`adapter:github-copilot.session.info`](#adapter:github-copilot.session.info) | event | — |
| `session.model_change` | [`adapter:github-copilot.session.model_change`](#adapter:github-copilot.session.model_change) | event | — |
| `session.resume` | [`adapter:github-copilot.session.resume`](#adapter:github-copilot.session.resume) | event | — |
| `session.start` | [`adapter:github-copilot.session.start`](#adapter:github-copilot.session.start) | event | — |
| `session.truncation` | [`adapter:github-copilot.session.truncation`](#adapter:github-copilot.session.truncation) | event | — |
| `session.usage_info` | [`adapter:github-copilot.session.usage_info`](#adapter:github-copilot.session.usage_info) | event | — |
| `system.message` | [`adapter:github-copilot.system.message`](#adapter:github-copilot.system.message) | event | — |
| `tool.execution_complete` | [`adapter:github-copilot.tool.execution_complete`](#adapter:github-copilot.tool.execution_complete) | event | — |
| `tool.execution_partial_result` | [`adapter:github-copilot.tool.execution_partial_result`](#adapter:github-copilot.tool.execution_partial_result) | event | — |
| `tool.execution_start` | [`adapter:github-copilot.tool.execution_start`](#adapter:github-copilot.tool.execution_start) | event | — |
| `tool.user_requested` | [`adapter:github-copilot.tool.user_requested`](#adapter:github-copilot.tool.user_requested) | event | — |
| `turn.state_changed` | [`adapter:github-copilot.turn.state_changed`](#adapter:github-copilot.turn.state_changed) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/github-copilot-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.step_finished` | [`adapter:github-copilot.turn.step_finished`](#adapter:github-copilot.turn.step_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/github-copilot-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.step_started` | [`adapter:github-copilot.turn.step_started`](#adapter:github-copilot.turn.step_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/github-copilot-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_finished` | [`adapter:github-copilot.turn.turn_finished`](#adapter:github-copilot.turn.turn_finished) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/github-copilot-sdk/src/namespaces/schemas/turn-state.ts) |
| `turn.turn_started` | [`adapter:github-copilot.turn.turn_started`](#adapter:github-copilot.turn.turn_started) | event | [`turn-state.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/adapters/implementations/github-copilot-sdk/src/namespaces/schemas/turn-state.ts) |
| `user.message` | [`adapter:github-copilot.user.message`](#adapter:github-copilot.user.message) | event | — |

## Subject Details

### <a id="adapter:github-copilot.abort"></a>`adapter:github-copilot.abort` (event)

Subject: `adapter:github-copilot.abort`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ reason: string; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"abort"` | yes |

### <a id="adapter:github-copilot.assistant.message"></a>`adapter:github-copilot.assistant.message` (event)

Subject: `adapter:github-copilot.assistant.message`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ messageId: string; content: string; toolRequests?: { toolCallId: string; name: string; arguments?: { [k: string]: unknown; } \| undefined; type?: "function" \| "custom" \| undefined; toolTitle?: string \| undefined; mcpServerName?: string \| undefined; intentionSummary?: string \| null \| undefined; }[] \| undefined; reasoningOpaque?: string \| undefined; reasoningText?: string \| undefined; encryptedContent?: string \| undefined; phase?: string \| undefined; outputTokens?: number \| undefined; interactionId?: string \| undefined; requestId?: string \| undefined; parentToolCallId?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"assistant.message"` | yes |

### <a id="adapter:github-copilot.assistant.reasoning"></a>`adapter:github-copilot.assistant.reasoning` (event)

Subject: `adapter:github-copilot.assistant.reasoning`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ reasoningId: string; content: string; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"assistant.reasoning"` | yes |

### <a id="adapter:github-copilot.assistant.reasoning_delta"></a>`adapter:github-copilot.assistant.reasoning_delta` (event)

Subject: `adapter:github-copilot.assistant.reasoning_delta`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ reasoningId: string; deltaContent: string; }` | yes |
| `ephemeral` | `true` | yes |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"assistant.reasoning_delta"` | yes |

### <a id="adapter:github-copilot.assistant.turn_end"></a>`adapter:github-copilot.assistant.turn_end` (event)

Subject: `adapter:github-copilot.assistant.turn_end`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ turnId: string; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"assistant.turn_end"` | yes |

### <a id="adapter:github-copilot.assistant.turn_start"></a>`adapter:github-copilot.assistant.turn_start` (event)

Subject: `adapter:github-copilot.assistant.turn_start`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ turnId: string; interactionId?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"assistant.turn_start"` | yes |

### <a id="adapter:github-copilot.assistant.usage"></a>`adapter:github-copilot.assistant.usage` (event)

Subject: `adapter:github-copilot.assistant.usage`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ model: string; inputTokens?: number \| undefined; outputTokens?: number \| undefined; cacheReadTokens?: number \| undefined; cacheWriteTokens?: number \| undefined; cost?: number \| undefined; duration?: number \| undefined; ttftMs?: number \| undefined; interTokenLatencyMs?: number \| undefined; initiator?: string \| undefined; apiCallId?: string \| undefined; providerCallId?: string \| undefined; parentToolCallId?: string \| undefined; quotaSnapshots?: { [k: string]: { isUnlimitedEntitlement: boolean; entitlementRequests: number; usedRequests: number; usageAllowedWithExhaustedQuota: boolean; overage: number; overageAllowedWithExhaustedQuota: boolean; remainingPercentage: number; resetDate?: string \| undefined; }; } \| undefined; copilotUsage?: { tokenDetails: { batchSize: number; costPerBatch: number; tokenCount: number; tokenType: string; }[]; totalNanoAiu: number; } \| undefined; reasoningEffort?: string \| undefined; }` | yes |
| `ephemeral` | `true` | yes |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"assistant.usage"` | yes |

### <a id="adapter:github-copilot.can_use_tool"></a>`adapter:github-copilot.can_use_tool` (rpc)

Scoped tool approval schema for adapter connector buses.

`sessionId` is optional here because the connector emits the approval request
before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
(or equivalent) injects `sessionId` from its own context before forwarding
to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.

Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
should define their own schema rather than extending this one.

Subject: `adapter:github-copilot.can_use_tool`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `adapterName` | `string` | yes |
| `adapterSessionId` | `string \| undefined` | no |
| `agentId` | `string` | yes |
| `args` | `Record<string, unknown> \| undefined` | no |
| `clientId` | `string \| undefined` | no |
| `messageId` | `string \| undefined` | no |
| `occurredAt` | `number \| undefined` | no |
| `providerConfigId` | `string \| undefined` | no |
| `reasoning` | `string \| undefined` | no |
| `sessionId` | `string \| undefined` | no |
| `toolCallId` | `string` | yes |
| `toolName` | `string \| undefined` | no |
| `turnId` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `action` | `"allow" \| "deny"` | yes |
| `message` | `string \| undefined` | no |
| `shouldAbort` | `boolean \| undefined` | no |
| `updatedInput` | `Record<string, unknown> \| undefined` | no |
| `updatedPermissions` | `unknown[] \| undefined` | no |

### <a id="adapter:github-copilot.hook.end"></a>`adapter:github-copilot.hook.end` (event)

Subject: `adapter:github-copilot.hook.end`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ hookInvocationId: string; hookType: string; output?: { [k: string]: unknown; } \| undefined; success: boolean; error?: { message: string; stack?: string \| undefined; } \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"hook.end"` | yes |

### <a id="adapter:github-copilot.hook.start"></a>`adapter:github-copilot.hook.start` (event)

Subject: `adapter:github-copilot.hook.start`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ hookInvocationId: string; hookType: string; input?: { [k: string]: unknown; } \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"hook.start"` | yes |

### <a id="adapter:github-copilot.sdk.event"></a>`adapter:github-copilot.sdk.event` (event)

Subject: `adapter:github-copilot.sdk.event`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ sessionId: string; version: number; producer: string; copilotVersion: string; startTime: string; selectedModel?: string \| undefined; reasoningEffort?: string \| undefined; context?: { cwd: string; gitRoot?: string \| undefined; repository?: string \| undefined; hostType?: "github" \| "ado" \| undefined; branch?: string \| undefined; headCommit?: string \| undefined; baseCommit?: string \| undefined; } \| undefined; alreadyInUse?: boolean \| undefined; remoteSteerable?: boolean \| undefined; } \| { resumeTime: string; eventCount: number; selectedModel?: string \| undefined; reasoningEffort?: string \| undefined; context?: { cwd: string; gitRoot?: string \| undefined; repository?: string \| undefined; hostType?: "github" \| "ado" \| undefined; branch?: string \| undefined; headCommit?: string \| undefined; baseCommit?: string \| undefined; } \| undefined; alreadyInUse?: boolean \| undefined; remoteSteerable?: boolean \| undefined; } \| { remoteSteerable: boolean; } \| { errorType: string; message: string; stack?: string \| undefined; statusCode?: number \| undefined; providerCallId?: string \| undefined; url?: string \| undefined; } \| { aborted?: boolean \| undefined; } \| { title: string; } \| { infoType: string; message: string; url?: string \| undefined; } \| { warningType: string; message: string; url?: string \| undefined; } \| { previousModel?: string \| undefined; newModel: string; previousReasoningEffort?: string \| undefined; reasoningEffort?: string \| undefined; } \| { previousMode: string; newMode: string; } \| { operation: "create" \| "update" \| "delete"; } \| { path: string; operation: "create" \| "update"; } \| { handoffTime: string; sourceType: "local" \| "remote"; repository?: { owner: string; name: string; branch?: string \| undefined; } \| undefined; context?: string \| undefined; summary?: string \| undefined; remoteSessionId?: string \| undefined; host?: string \| undefined; } \| { tokenLimit: number; preTruncationTokensInMessages: number; preTruncationMessagesLength: number; postTruncationTokensInMessages: number; postTruncationMessagesLength: number; tokensRemovedDuringTruncation: number; messagesRemovedDuringTruncation: number; performedBy: string; } \| { upToEventId: string; eventsRemoved: number; } \| { shutdownType: "error" \| "routine"; errorReason?: string \| undefined; totalPremiumRequests: number; totalApiDurationMs: number; sessionStartTime: number; codeChanges: { linesAdded: number; linesRemoved: number; filesModified: string[]; }; modelMetrics: { [k: string]: { requests: { count: number; cost: number; }; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; }; }; }; currentModel?: string \| undefined; currentTokens?: number \| undefined; systemTokens?: number \| undefined; conversationTokens?: number \| undefined; toolDefinitionsTokens?: number \| undefined; } \| { cwd: string; gitRoot?: string \| undefined; repository?: string \| undefined; hostType?: "github" \| "ado" \| undefined; branch?: string \| undefined; headCommit?: string \| undefined; baseCommit?: string \| undefined; } \| { tokenLimit: number; currentTokens: number; messagesLength: number; systemTokens?: number \| undefined; conversationTokens?: number \| undefined; toolDefinitionsTokens?: number \| undefined; isInitial?: boolean \| undefined; } \| { systemTokens?: number \| undefined; conversationTokens?: number \| undefined; toolDefinitionsTokens?: number \| undefined; } \| { success: boolean; error?: string \| undefined; preCompactionTokens?: number \| undefined; postCompactionTokens?: number \| undefined; preCompactionMessagesLength?: number \| undefined; messagesRemoved?: number \| undefined; tokensRemoved?: number \| undefined; summaryContent?: string \| undefined; checkpointNumber?: number \| undefined; checkpointPath?: string \| undefined; compactionTokensUsed?: { input: number; output: number; cachedInput: number; } \| undefined; requestId?: string \| undefined; systemTokens?: number \| undefined; conversationTokens?: number \| undefined; toolDefinitionsTokens?: number \| undefined; } \| { summary?: string \| undefined; success?: boolean \| undefined; } \| { content: string; transformedContent?: string \| undefined; attachments?: ({ type: "file"; path: string; displayName: string; lineRange?: { start: number; end: number; } \| undefined; } \| { type: "directory"; path: string; displayName: string; } \| { type: "selection"; filePath: string; displayName: string; text: string; selection: { start: { line: number; character: number; }; end: { line: number; character: number; }; }; } \| { type: "github_reference"; number: number; title: string; referenceType: "pr" \| "issue" \| "discussion"; state: string; url: string; } \| { type: "blob"; data: string; mimeType: string; displayName?: string \| undefined; })[] \| undefined; source?: string \| undefined; agentMode?: "interactive" \| "plan" \| "autopilot" \| "shell" \| undefined; interactionId?: string \| undefined; } \| {} \| { turnId: string; interactionId?: string \| undefined; } \| { intent: string; } \| { reasoningId: string; content: string; } \| { reasoningId: string; deltaContent: string; } \| { totalResponseSizeBytes: number; } \| { messageId: string; content: string; toolRequests?: { toolCallId: string; name: string; arguments?: { [k: string]: unknown; } \| undefined; type?: "function" \| "custom" \| undefined; toolTitle?: string \| undefined; mcpServerName?: string \| undefined; intentionSummary?: string \| null \| undefined; }[] \| undefined; reasoningOpaque?: string \| undefined; reasoningText?: string \| undefined; encryptedContent?: string \| undefined; phase?: string \| undefined; outputTokens?: number \| undefined; interactionId?: string \| undefined; requestId?: string \| undefined; parentToolCallId?: string \| undefined; } \| { messageId: string; deltaContent: string; parentToolCallId?: string \| undefined; } \| { turnId: string; } \| { model: string; inputTokens?: number \| undefined; outputTokens?: number \| undefined; cacheReadTokens?: number \| undefined; cacheWriteTokens?: number \| undefined; cost?: number \| undefined; duration?: number \| undefined; ttftMs?: number \| undefined; interTokenLatencyMs?: number \| undefined; initiator?: string \| undefined; apiCallId?: string \| undefined; providerCallId?: string \| undefined; parentToolCallId?: string \| undefined; quotaSnapshots?: { [k: string]: { isUnlimitedEntitlement: boolean; entitlementRequests: number; usedRequests: number; usageAllowedWithExhaustedQuota: boolean; overage: number; overageAllowedWithExhaustedQuota: boolean; remainingPercentage: number; resetDate?: string \| undefined; }; } \| undefined; copilotUsage?: { tokenDetails: { batchSize: number; costPerBatch: number; tokenCount: number; tokenType: string; }[]; totalNanoAiu: number; } \| undefined; reasoningEffort?: string \| undefined; } \| { reason: string; } \| { toolCallId: string; toolName: string; arguments?: { [k: string]: unknown; } \| undefined; } \| { toolCallId: string; toolName: string; arguments?: { [k: string]: unknown; } \| undefined; mcpServerName?: string \| undefined; mcpToolName?: string \| undefined; parentToolCallId?: string \| undefined; } \| { toolCallId: string; partialOutput: string; } \| { toolCallId: string; progressMessage: string; } \| { toolCallId: string; success: boolean; model?: string \| undefined; interactionId?: string \| undefined; isUserRequested?: boolean \| undefined; result?: { content: string; detailedContent?: string \| undefined; contents?: ({ type: "text"; text: string; } \| { type: "terminal"; text: string; exitCode?: number \| undefined; cwd?: string \| undefined; } \| { type: "image"; data: string; mimeType: string; } \| { type: "audio"; data: string; mimeType: string; } \| { icons?: { src: string; mimeType?: string \| undefined; sizes?: string[] \| undefined; theme?: "light" \| "dark" \| undefined; }[] \| undefined; name: string; title?: string \| undefined; uri: string; description?: string \| undefined; mimeType?: string \| undefined; size?: number \| undefined; type: "resource_link"; } \| { type: "resource"; resource: { uri: string; mimeType?: string \| undefined; text: string; } \| { uri: string; mimeType?: string \| undefined; blob: string; }; })[] \| undefined; } \| undefined; error?: { message: string; code?: string \| undefined; } \| undefined; toolTelemetry?: { [k: string]: unknown; } \| undefined; parentToolCallId?: string \| undefined; } \| { name: string; path: string; content: string; allowedTools?: string[] \| undefined; pluginName?: string \| undefined; pluginVersion?: string \| undefined; description?: string \| undefined; } \| { toolCallId: string; agentName: string; agentDisplayName: string; agentDescription: string; } \| { toolCallId: string; agentName: string; agentDisplayName: string; model?: string \| undefined; totalToolCalls?: number \| undefined; totalTokens?: number \| undefined; durationMs?: number \| undefined; } \| { toolCallId: string; agentName: string; agentDisplayName: string; error: string; model?: string \| undefined; totalToolCalls?: number \| undefined; totalTokens?: number \| undefined; durationMs?: number \| undefined; } \| { agentName: string; agentDisplayName: string; tools: string[] \| null; } \| { hookInvocationId: string; hookType: string; input?: { [k: string]: unknown; } \| undefined; } \| { hookInvocationId: string; hookType: string; output?: { [k: string]: unknown; } \| undefined; success: boolean; error?: { message: string; stack?: string \| undefined; } \| undefined; } \| { content: string; role: "system" \| "developer"; name?: string \| undefined; metadata?: { promptVersion?: string \| undefined; variables?: { [k: string]: unknown; } \| undefined; } \| undefined; } \| { content: string; kind: { type: "agent_completed"; agentId: string; agentType: string; status: "completed" \| "failed"; description?: string \| undefined; prompt?: string \| undefined; } \| { type: "agent_idle"; agentId: string; agentType: string; description?: string \| undefined; } \| { type: "shell_completed"; shellId: string; exitCode?: number \| undefined; description?: string \| undefined; } \| { type: "shell_detached_completed"; shellId: string; description?: string \| undefined; }; } \| { requestId: string; permissionRequest: { kind: "shell"; toolCallId?: string \| undefined; fullCommandText: string; intention: string; commands: { identifier: string; readOnly: boolean; }[]; possiblePaths: string[]; possibleUrls: { url: string; }[]; hasWriteFileRedirection: boolean; canOfferSessionApproval: boolean; warning?: string \| undefined; } \| { kind: "write"; toolCallId?: string \| undefined; intention: string; fileName: string; diff: string; newFileContents?: string \| undefined; } \| { kind: "read"; toolCallId?: string \| undefined; intention: string; path: string; } \| { kind: "mcp"; toolCallId?: string \| undefined; serverName: string; toolName: string; toolTitle: string; args?: { [k: string]: unknown; } \| undefined; readOnly: boolean; } \| { kind: "url"; toolCallId?: string \| undefined; intention: string; url: string; } \| { kind: "memory"; toolCallId?: string \| undefined; subject: string; fact: string; citations: string; } \| { kind: "custom-tool"; toolCallId?: string \| undefined; toolName: string; toolDescription: string; args?: { [k: string]: unknown; } \| undefined; } \| { kind: "hook"; toolCallId?: string \| undefined; toolName: string; toolArgs?: { [k: string]: unknown; } \| undefined; hookMessage?: string \| undefined; }; resolvedByHook?: boolean \| undefined; } \| { requestId: string; result: { kind: "approved" \| "denied-by-rules" \| "denied-no-approval-rule-and-could-not-request-from-user" \| "denied-interactively-by-user" \| "denied-by-content-exclusion-policy" \| "denied-by-permission-request-hook"; }; } \| { requestId: string; question: string; choices?: string[] \| undefined; allowFreeform?: boolean \| undefined; toolCallId?: string \| undefined; } \| { requestId: string; answer?: string \| undefined; wasFreeform?: boolean \| undefined; } \| { [k: string]: unknown; requestId: string; toolCallId?: string \| undefined; elicitationSource?: string \| undefined; message: string; mode?: "url" \| "form" \| undefined; requestedSchema?: { type: "object"; properties: { [k: string]: unknown; }; required?: string[] \| undefined; } \| undefined; url?: string \| undefined; } \| { requestId: string; action?: "cancel" \| "accept" \| "decline" \| undefined; content?: { [k: string]: string \| number \| boolean \| string[]; } \| undefined; } \| { [k: string]: unknown; requestId: string; serverName: string; mcpRequestId: string \| number; } \| { requestId: string; } \| { requestId: string; serverName: string; serverUrl: string; staticClientConfig?: { clientId: string; publicClient?: boolean \| undefined; } \| undefined; } \| { requestId: string; sessionId: string; toolCallId: string; toolName: string; arguments?: { [k: string]: unknown; } \| undefined; traceparent?: string \| undefined; tracestate?: string \| undefined; } \| { requestId: string; command: string; } \| { requestId: string; command: string; commandName: string; args: string; } \| { commands: { name: string; description?: string \| undefined; }[]; } \| { ui?: { elicitation?: boolean \| undefined; } \| undefined; } \| { requestId: string; summary: string; planContent: string; actions: string[]; recommendedAction: string; } \| { requestId: string; approved?: boolean \| undefined; selectedAction?: string \| undefined; autoApproveEdits?: boolean \| undefined; feedback?: string \| undefined; } \| { model: string; } \| { skills: { name: string; description: string; source: string; userInvocable: boolean; enabled: boolean; path?: string \| undefined; }[]; } \| { agents: { id: string; name: string; displayName: string; description: string; source: string; tools: string[]; userInvocable: boolean; model?: string \| undefined; }[]; warnings: string[]; errors: string[]; } \| { servers: { name: string; status: "failed" \| "pending" \| "disabled" \| "connected" \| "needs-auth" \| "not_configured"; source?: string \| undefined; error?: string \| undefined; }[]; } \| { serverName: string; status: "failed" \| "pending" \| "disabled" \| "connected" \| "needs-auth" \| "not_configured"; } \| { extensions: { id: string; name: string; source: "user" \| "project"; status: "failed" \| "running" \| "disabled" \| "starting"; }[]; }` | yes |
| `ephemeral` | `boolean \| undefined \| true` | no |
| `id` | `string` | yes |
| `lastAssistantMessageContent` | `string \| undefined` | no |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.start" \| "session.resume" \| "session.remote_steerable_changed" \| "session.error" \| "session.idle" \| "session.title_changed" \| "session.info" \| "session.warning" \| "session.model_change" \| "session.mode_changed" \| "session.plan_changed" \| "session.workspace_file_changed" \| "session.handoff" \| "session.truncation" \| "session.snapshot_rewind" \| "session.shutdown" \| "session.context_changed" \| "session.usage_info" \| "session.compaction_start" \| "session.compaction_complete" \| "session.task_complete" \| "user.message" \| "pending_messages.modified" \| "assistant.turn_start" \| "assistant.intent" \| "assistant.reasoning" \| "assistant.reasoning_delta" \| "assistant.streaming_delta" \| "assistant.message" \| "assistant.message_delta" \| "assistant.turn_end" \| "assistant.usage" \| "abort" \| "tool.user_requested" \| "tool.execution_start" \| "tool.execution_partial_result" \| "tool.execution_progress" \| "tool.execution_complete" \| "skill.invoked" \| "subagent.started" \| "subagent.completed" \| "subagent.failed" \| "subagent.selected" \| "subagent.deselected" \| "hook.start" \| "hook.end" \| "system.message" \| "system.notification" \| "permission.requested" \| "permission.completed" \| "user_input.requested" \| "user_input.completed" \| "elicitation.requested" \| "elicitation.completed" \| "sampling.requested" \| "sampling.completed" \| "mcp.oauth_required" \| "mcp.oauth_completed" \| "external_tool.requested" \| "external_tool.completed" \| "command.queued" \| "command.execute" \| "command.completed" \| "commands.changed" \| "capabilities.changed" \| "exit_plan_mode.requested" \| "exit_plan_mode.completed" \| "session.tools_updated" \| "session.background_tasks_changed" \| "session.skills_loaded" \| "session.custom_agents_updated" \| "session.mcp_servers_loaded" \| "session.mcp_server_status_changed" \| "session.extensions_loaded"` | yes |

### <a id="adapter:github-copilot.session.error"></a>`adapter:github-copilot.session.error` (event)

Subject: `adapter:github-copilot.session.error`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ errorType: string; message: string; stack?: string \| undefined; statusCode?: number \| undefined; providerCallId?: string \| undefined; url?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.error"` | yes |

### <a id="adapter:github-copilot.session.idle"></a>`adapter:github-copilot.session.idle` (event)

Subject: `adapter:github-copilot.session.idle`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ aborted?: boolean \| undefined; }` | yes |
| `ephemeral` | `true` | yes |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.idle"` | yes |

### <a id="adapter:github-copilot.session.info"></a>`adapter:github-copilot.session.info` (event)

Subject: `adapter:github-copilot.session.info`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ infoType: string; message: string; url?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.info"` | yes |

### <a id="adapter:github-copilot.session.model_change"></a>`adapter:github-copilot.session.model_change` (event)

Subject: `adapter:github-copilot.session.model_change`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ previousModel?: string \| undefined; newModel: string; previousReasoningEffort?: string \| undefined; reasoningEffort?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.model_change"` | yes |

### <a id="adapter:github-copilot.session.resume"></a>`adapter:github-copilot.session.resume` (event)

Subject: `adapter:github-copilot.session.resume`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ resumeTime: string; eventCount: number; selectedModel?: string \| undefined; reasoningEffort?: string \| undefined; context?: { cwd: string; gitRoot?: string \| undefined; repository?: string \| undefined; hostType?: "github" \| "ado" \| undefined; branch?: string \| undefined; headCommit?: string \| undefined; baseCommit?: string \| undefined; } \| undefined; alreadyInUse?: boolean \| undefined; remoteSteerable?: boolean \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.resume"` | yes |

### <a id="adapter:github-copilot.session.start"></a>`adapter:github-copilot.session.start` (event)

Subject: `adapter:github-copilot.session.start`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ sessionId: string; version: number; producer: string; copilotVersion: string; startTime: string; selectedModel?: string \| undefined; reasoningEffort?: string \| undefined; context?: { cwd: string; gitRoot?: string \| undefined; repository?: string \| undefined; hostType?: "github" \| "ado" \| undefined; branch?: string \| undefined; headCommit?: string \| undefined; baseCommit?: string \| undefined; } \| undefined; alreadyInUse?: boolean \| undefined; remoteSteerable?: boolean \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.start"` | yes |

### <a id="adapter:github-copilot.session.truncation"></a>`adapter:github-copilot.session.truncation` (event)

Subject: `adapter:github-copilot.session.truncation`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ tokenLimit: number; preTruncationTokensInMessages: number; preTruncationMessagesLength: number; postTruncationTokensInMessages: number; postTruncationMessagesLength: number; tokensRemovedDuringTruncation: number; messagesRemovedDuringTruncation: number; performedBy: string; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.truncation"` | yes |

### <a id="adapter:github-copilot.session.usage_info"></a>`adapter:github-copilot.session.usage_info` (event)

Subject: `adapter:github-copilot.session.usage_info`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ tokenLimit: number; currentTokens: number; messagesLength: number; systemTokens?: number \| undefined; conversationTokens?: number \| undefined; toolDefinitionsTokens?: number \| undefined; isInitial?: boolean \| undefined; }` | yes |
| `ephemeral` | `true` | yes |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"session.usage_info"` | yes |

### <a id="adapter:github-copilot.system.message"></a>`adapter:github-copilot.system.message` (event)

Subject: `adapter:github-copilot.system.message`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ content: string; role: "system" \| "developer"; name?: string \| undefined; metadata?: { promptVersion?: string \| undefined; variables?: { [k: string]: unknown; } \| undefined; } \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"system.message"` | yes |

### <a id="adapter:github-copilot.tool.execution_complete"></a>`adapter:github-copilot.tool.execution_complete` (event)

Subject: `adapter:github-copilot.tool.execution_complete`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ toolCallId: string; success: boolean; model?: string \| undefined; interactionId?: string \| undefined; isUserRequested?: boolean \| undefined; result?: { content: string; detailedContent?: string \| undefined; contents?: ({ type: "text"; text: string; } \| { type: "terminal"; text: string; exitCode?: number \| undefined; cwd?: string \| undefined; } \| { type: "image"; data: string; mimeType: string; } \| { type: "audio"; data: string; mimeType: string; } \| { icons?: { src: string; mimeType?: string \| undefined; sizes?: string[] \| undefined; theme?: "light" \| "dark" \| undefined; }[] \| undefined; name: string; title?: string \| undefined; uri: string; description?: string \| undefined; mimeType?: string \| undefined; size?: number \| undefined; type: "resource_link"; } \| { type: "resource"; resource: { uri: string; mimeType?: string \| undefined; text: string; } \| { uri: string; mimeType?: string \| undefined; blob: string; }; })[] \| undefined; } \| undefined; error?: { message: string; code?: string \| undefined; } \| undefined; toolTelemetry?: { [k: string]: unknown; } \| undefined; parentToolCallId?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"tool.execution_complete"` | yes |

### <a id="adapter:github-copilot.tool.execution_partial_result"></a>`adapter:github-copilot.tool.execution_partial_result` (event)

Subject: `adapter:github-copilot.tool.execution_partial_result`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ toolCallId: string; partialOutput: string; }` | yes |
| `ephemeral` | `true` | yes |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"tool.execution_partial_result"` | yes |

### <a id="adapter:github-copilot.tool.execution_start"></a>`adapter:github-copilot.tool.execution_start` (event)

Subject: `adapter:github-copilot.tool.execution_start`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ toolCallId: string; toolName: string; arguments?: { [k: string]: unknown; } \| undefined; mcpServerName?: string \| undefined; mcpToolName?: string \| undefined; parentToolCallId?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"tool.execution_start"` | yes |

### <a id="adapter:github-copilot.tool.user_requested"></a>`adapter:github-copilot.tool.user_requested` (event)

Subject: `adapter:github-copilot.tool.user_requested`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ toolCallId: string; toolName: string; arguments?: { [k: string]: unknown; } \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"tool.user_requested"` | yes |

### <a id="adapter:github-copilot.turn.state_changed"></a>`adapter:github-copilot.turn.state_changed` (event)

Turn state change event

Subject: `adapter:github-copilot.turn.state_changed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:github-copilot.turn.step_finished"></a>`adapter:github-copilot.turn.step_finished` (event)

Turn state change event

Subject: `adapter:github-copilot.turn.step_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:github-copilot.turn.step_started"></a>`adapter:github-copilot.turn.step_started` (event)

Turn state change event

Subject: `adapter:github-copilot.turn.step_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:github-copilot.turn.turn_finished"></a>`adapter:github-copilot.turn.turn_finished` (event)

Turn state change event

Subject: `adapter:github-copilot.turn.turn_finished`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:github-copilot.turn.turn_started"></a>`adapter:github-copilot.turn.turn_started` (event)

Turn state change event

Subject: `adapter:github-copilot.turn.turn_started`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `adapterId` | `string` | yes |
| `agentId` | `string` | yes |
| `newState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `oldState` | `"idle" \| "turn_started" \| "step_started" \| "step_finished" \| "turn_finished"` | yes |
| `timestamp` | `number` | yes |

### <a id="adapter:github-copilot.user.message"></a>`adapter:github-copilot.user.message` (event)

Subject: `adapter:github-copilot.user.message`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `data` | `{ content: string; transformedContent?: string \| undefined; attachments?: ({ type: "file"; path: string; displayName: string; lineRange?: { start: number; end: number; } \| undefined; } \| { type: "directory"; path: string; displayName: string; } \| { type: "selection"; filePath: string; displayName: string; text: string; selection: { start: { line: number; character: number; }; end: { line: number; character: number; }; }; } \| { type: "github_reference"; number: number; title: string; referenceType: "pr" \| "issue" \| "discussion"; state: string; url: string; } \| { type: "blob"; data: string; mimeType: string; displayName?: string \| undefined; })[] \| undefined; source?: string \| undefined; agentMode?: "interactive" \| "plan" \| "autopilot" \| "shell" \| undefined; interactionId?: string \| undefined; }` | yes |
| `ephemeral` | `boolean \| undefined` | no |
| `id` | `string` | yes |
| `parentId` | `string \| null` | yes |
| `timestamp` | `string` | yes |
| `type` | `"user.message"` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*

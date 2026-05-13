# @makaio/client-claude-code

Static client definition and schema library for the Anthropic Claude Code CLI. This package declares the user-facing identity of the `claude` binary within the framework — its stable ID, native tool catalog, capability tags, hook event map, and the full set of Zod schemas covering Claude Code's wire protocol (SDK messages, content blocks, status-line payloads, config/wiring RPCs). A separate `./runtime` entrypoint registers the client-native bus namespace and provides the `ClaudeCodeClientService` that bridges raw hook events into normalized `client.session.*` observations.

## Client Identity

| Field | Value |
|-------|-------|
| `id` | `claude-code` |
| `name` | `Claude Code` |
| `version` | `0.1.0` |
| `description` | Anthropic Claude Code CLI — an agentic coding assistant |
| `binary.name` | `claude` |
| `binary.supportedVersions` | `>=1.0.0` |
| `defaultApprovalPolicy` | `full-access` |
| `defaultProviderId` | `anthropic-oauth` |
| `configIsolation.envVar` | `CLAUDE_CONFIG_DIR` |
| `configIsolation.defaultPath` | `~/.claude` |

### Runtime Capabilities

| Capability | Value |
|-----------|-------|
| `supportsHooks` | `true` |
| `supportsStatusline` | `true` |
| `supportsSupervisorLaunch` | `false` |
| `supportsManagedBinary` | `false` |

### Hook Events

| Hook Name | Framework Subject |
|-----------|------------------|
| `SessionStart` | `client.session.started` |
| `UserPromptSubmit` | `client.session.userPrompt.submitted` |
| `PreToolUse` | `client.session.tool.pre` |
| `PostToolUse` | `client.session.tool.post` |
| `Stop` | `client.session.turn.completed` |
| `SubagentStop` | _(no framework subject — not normalized)_ |
| `Notification` | _(no framework subject — not normalized)_ |
| `MCPServerStart` | _(no framework subject — not normalized)_ |
| `MCPServerStop` | _(no framework subject — not normalized)_ |

## Native Tools

| Tool | Friendly Name | Category | Capabilities |
|------|---------------|----------|-------------|
| `bash` | Terminal | System | `shell.execute`, `file.read`, `file.write`, `file.delete`, `network.request`, `process.manage` |
| `text_editor` | Text Editor | Files | `file.read`, `file.write` |
| `list_directory` | List Directory | Files | `file.read`, `search.files` |
| `read_file` | Read File | Files | `file.read` |
| `write_file` | Write File | Files | `file.write` |

## Served By (Adapters)

| Adapter ID | Package |
|-----------|---------|
| `claude-code` | `@makaio/ai-adapters-claude-agent-sdk` — Claude Agent SDK bridge |
| `claude-code-cli` | `@makaio/ai-adapters-claude-code-cli` — stdio streaming via `claude` binary |

## Exports

### Main entrypoint (`.`)

| Export | Kind | Description |
|--------|------|-------------|
| `clientDefinition` | `ClientDefinition` | Static client definition (identity, tools, approval policy) |
| `claudeCodePackage` | `MakaioExtension` | Package descriptor for framework extension discovery |
| `buildClaudeAccountOrgUuidIdentifier` | function | Build a canonical `account-org-uuid` strong identifier from two UUIDs |
| `claudeReasoningLevels` | `ReasoningLevelMap` | Named reasoning levels mapped to max-token budgets (none/low/medium/high/extra-high) |

#### SDK Message Schemas

| Export | Description |
|--------|-------------|
| `SDKMessageSchema` | Union of all SDK message types |
| `SDKAssistantMessageSchema` | Assistant turn message |
| `SDKUserMessageSchema` | User turn message |
| `SDKSystemMessageSchema` | System message (init + compact-boundary variants) |
| `SDKResultMessageSchema` / `SDKResultSuccessMessageSchema` / `SDKResultErrorMessageSchema` | Result messages |
| `SDKStreamEventMessageSchema` | Streaming event wrapper |
| `StreamEventSchema` | Stream event discriminated union |
| `MessageParamSchema` | Request message parameter |
| `BetaMessageSchema` | Beta API response message |
| `KNOWN_SDK_MESSAGE_TYPES` / `KNOWN_SYSTEM_SUBTYPES` | Known type/subtype string constants |

#### Content Block Schemas (input/output)

| Category | Notable Schemas |
|----------|----------------|
| Text | `BetaTextBlockSchema`, `BetaTextBlockParamSchema` |
| Tool use/result | `BetaToolUseBlockSchema`, `BetaToolResultBlockParamSchema` |
| Thinking | `BetaThinkingBlockSchema`, `BetaRedactedThinkingBlockSchema` |
| MCP | `BetaMCPToolUseBlockSchema`, `BetaMCPToolResultBlockSchema` |
| Code execution | `BetaCodeExecutionToolResultBlockSchema` and param/content variants |
| Web search | `BetaWebSearchToolResultBlockSchema` and param/content/error variants |
| Container upload | `BetaContainerUploadBlockSchema` |
| Server tool use | `BetaServerToolUseBlockSchema` |
| Document / Image | `BetaDocumentBlockParamSchema`, `BetaImageBlockParamSchema` |
| Union | `BetaContentBlockSchema`, `BetaContentBlockParamSchema` |

#### Status-line Schemas

| Export | Description |
|--------|-------------|
| `ClaudeCodeStatuslineRawPayloadSchema` | Raw status-line payload forwarded by the CLI bridge |
| `ClaudeStatuslinePayloadSchema` | Parsed status-line payload |
| `ClaudeStatuslineCurrentUsageSchema` | Token usage within a session |
| `ClaudeStatuslineRateLimitsSchema` / `ClaudeStatuslineRateLimitWindowSchema` | Rate-limit windows |

#### Config Schemas

| Export | Description |
|--------|-------------|
| `ClaudeCodeConfigSchemas` | Bus-subject schema map for all config RPCs |
| `ClaudeCodeScopeSchema` | Scope enum (`global` / `project` / `local`) |
| `ClaudeCodeHookDefinitionSchema` | Single hook definition |
| `ClaudeCodeHookMatcherGroupSchema` | Hook matcher group |
| `ClaudeCodeHooksPerScopeEntrySchema` | Per-scope hook entry |
| `ClaudeCodeStatuslineValueSchema` / `ClaudeCodeStatuslinePerScopeEntrySchema` | Status-line value + scope entry |
| `ClaudeCodePluginEntrySchema` | Extension plugin entry |

#### Wiring Schemas

| Export | Description |
|--------|-------------|
| `ClaudeCodeWiringSchemas` | Bus-subject schema map for wiring list/apply/remove RPCs |

#### Types

| Export | Description |
|--------|-------------|
| `ClaudeTurnState` | Per-turn state for a Claude Code session |
| `IQueryInterruptable` | Interface for interruptible query operations |
| `ClaudePermissionResult` | Result type for tool permission decisions |

### Runtime entrypoint (`./runtime`)

| Export | Kind | Description |
|--------|------|-------------|
| `claudeCodeClientRuntimePackage` | `MakaioExtension` | Registers `claude-code.runtime` namespace and creates the client service |
| `ClaudeCodeClientService` | class | Bridges raw hook events into normalized `client.session.*` observations |
| `ClaudeCodeClientSubjects` | namespace subjects | Typed bus subjects for `client:claude-code.*` |
| `normalizeClaudeCodeHook` | function | Normalizes a raw hook payload into a `ClaudeCodeNormalizedEvent` |
| `resolveClaudeCodeSettingsPaths` | function | Resolves settings file paths from environment + options |
| `CLAUDE_CODE_HOOK_SESSION_START` … `CLAUDE_CODE_HOOK_MCP_SERVER_STOP` | string constants | Hook event name constants |

### Server entrypoint (`./server`)

Default export is `[claudeCodePackage, claudeCodeClientRuntimePackage]` — the array of packages registered when this client is activated as a server entry.

## Installation

`@makaio/client-claude-code` is a private workspace package used internally by the framework.

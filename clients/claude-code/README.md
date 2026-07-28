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
| `binary.supportedVersions` | `^2.1.0` |
| `defaultApprovalPolicy` | `full-access` |
| `defaultAuth` | `anthropic-oauth` via client method `native` |
| `configIsolation.envVar` | `CLAUDE_CONFIG_DIR` |
| `configIsolation.defaultPath` | `~/.claude` |

### Authentication

| Method | Mode | Fields or native state | Portability |
|--------|------|------------------------|-------------|
| `native` | `inferred` | Persisted Claude Code state from the native config location/keychain | Local only |
| `oauth-token` | `explicit` | Required `oauthToken`; `CLAUDE_CODE_OAUTH_TOKEN` is an environment source hint | Portable |

The managed default uses `native` for `anthropic-oauth`. Anthropic API-key auth
is provider-owned and remains a separate explicit method. Adapters scrub all
competing Claude auth variables, create an `auth-only` lease for native auth or
an `empty` lease for explicit auth, then deliver only the selected method.

### Runtime Capabilities

| Capability | Value |
|-----------|-------|
| `supportsHooks` | `true` |
| `supportsStatusline` | `true` |
| `supportsSupervisorLaunch` | `false` |
| `supportsManagedBinary` | `true` |

### Hook Events

| Hook Name | Framework Subject | Response Capabilities |
|-----------|------------------|----------------------|
| `SessionStart` | `client.session.started` | `context.append` |
| `UserPromptSubmit` | `client.session.userPrompt.submitted` | *(none)* |
| `PreToolUse` | `client.session.tool.pre` | `approve`, `deny`, `context.append` |
| `PostToolUse` | `client.session.tool.post` | *(none)* |
| `Stop` | `client.session.turn.completed` | *(none)* |
| `SubagentStop` | _(no framework subject --- not normalized)_ | *(none)* |
| `Notification` | _(no framework subject --- not normalized)_ | *(none)* |
| `MCPServerStart` | _(no framework subject --- not normalized)_ | *(none)* |
| `MCPServerStop` | _(no framework subject --- not normalized)_ | *(none)* |

`PreToolUse` and `SessionStart` declare response capabilities. Events without capabilities use `makaio hook received` (fire-and-forget); events with them use `makaio hook handle` (request/response) and produce a native `hookSpecificOutput` JSON response. `PreToolUse` renders a permission decision; `SessionStart` renders `additionalContext` alone, since it has no decision to make.

### Hook Response Contract (`claude-code.tool-response@1`)

The `./runtime` entrypoint registers a `ProviderContractCatalogEntry` that defines how contributions are validated and composed for Claude Code:

| Field | Value |
|-------|-------|
| `contractId` | `claude-code.tool-response` |
| `version` | `1.1.0` |
| `supportedInteractions` | `PreToolUse`, `SessionStart`, `approve`, `deny`, `context.append` |

**Blockability:** `PreToolUse`, `approve`, and `deny` are blockable; `SessionStart` and `context.append` are not.

**Provider effect builders** (exported from `./runtime`):

| Builder | Decision |
|---------|----------|
| `createApproveEffect(reason?)` | `allow` |
| `createDenyEffect(reason?)` | `deny` |

**Composition:** deny wins over allow (restrictive precedence). Multiple `context.append` effects are concatenated with newlines. When only `context.append` effects are present, the default decision is `allow`. Closed-failure causes a `deny` with the failure detail as reason.

See [Client Hook Response Pipeline](../../docs/architecture/client-hook-responses.md) for the full architecture.

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
| `claude-code-tmux` | `@makaio/ai-adapters-claude-code-tmux` — interactive tmux-backed CLI |

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
| `normalizeClaudeCodeHook` | function | Normalizes a raw hook payload into an array of `ClaudeCodeNormalizedEvent`s (empty for unknown events) |
| `resolveClaudeCodeSettingsPaths` | function | Resolves settings file paths from environment + options |
| `CLAUDE_CODE_HOOK_SESSION_START` ... `CLAUDE_CODE_HOOK_MCP_SERVER_STOP` | string constants | Hook event name constants |
| `claudeCodeToolResponseContract` | `ProviderContractCatalogEntry` | Provider contract catalog entry for the `claude-code.tool-response` contract |
| `createApproveEffect` | function | Creates a provider contribution envelope with `decision: 'allow'` |
| `createDenyEffect` | function | Creates a provider contribution envelope with `decision: 'deny'` |
| `composeHookResponse` | function | Collects contributions from the registry and serializes the native Claude Code response |

### Server entrypoint (`./server`)

Default export is `[claudeCodePackage, claudeCodeClientRuntimePackage]` — the array of packages registered when this client is activated as a server entry.

## Installation

`@makaio/client-claude-code` is a private workspace package used internally by the framework.

# @makaio/client-codex

Static client definition and schema library for the OpenAI Codex CLI. This package declares the user-facing identity of the `codex` binary within the framework — its stable ID, native tool catalog with capability tags drawn from the shared `codexCapabilityMap`, hook event map, and Zod schemas covering Codex's hook configuration and wiring RPCs. A separate `./runtime` entrypoint registers the client-native bus namespace and provides the `CodexClientSessionService` that bridges raw hook events into normalized `client.session.*` observations.

## Client Identity

| Field | Value |
|-------|-------|
| `id` | `codex` |
| `name` | `Codex` |
| `version` | `0.1.0` |
| `description` | OpenAI Codex CLI — an agentic coding assistant |
| `binary.name` | `codex` |
| `binary.supportedVersions` | `0.144.1` |
| `defaultApprovalPolicy` | `full-access` |
| `defaultAuth` | `openai-codex` via client method `native` |
| `configIsolation.envVar` | `CODEX_HOME` |
| `configIsolation.defaultPath` | `~/.codex` |

### Authentication

| Method | Mode | Fields or native state | Codex delivery |
|--------|------|------------------------|----------------|
| `native` | `inferred` | Persisted `auth.json` or `Codex Auth` keychain state | Isolated local `CODEX_HOME` lease |
| `access-token` | `explicit` | Required `accessToken`; `CODEX_ACCESS_TOKEN` is an environment source hint | Selected subprocess environment |

The provider-owned `openai-codex/api-key` method is separate: its `apiKey` may
come from `OPENAI_API_KEY`, but the app-server adapter delivers it through
`account/login/start` after initialization. It is never treated as the Codex
access-token method. Native leases use compare-and-swap write-back so a refresh
is preserved without overwriting a concurrently changed canonical credential.

### Runtime Capabilities

| Capability | Value |
|-----------|-------|
| `supportsHooks` | `true` |
| `supportsStatusline` | `false` |
| `supportsSupervisorLaunch` | `true` |
| `supportsManagedBinary` | `true` |

### Hook Events

| Hook Name | Framework Subject | Response Capabilities |
|-----------|------------------|----------------------|
| `SessionStart` | `client.session.started` | `context.append`, `openai.codex-hook-response.block` |
| `UserPromptSubmit` | `client.session.userPrompt.submitted` | `context.append`, `openai.codex-hook-response.block` |
| `PreToolUse` | `client.session.tool.pre` | `context.append`, `openai.codex-hook-response.block`, `openai.codex-hook-response.permission.deny`, `openai.codex-hook-response.input.update` |
| `PostToolUse` | `client.session.tool.post` | `context.append`, `openai.codex-hook-response.block` |
| `Stop` | `client.session.turn.completed` | `openai.codex-hook-response.block` |

All five events synchronously consume JSON output in the pinned upstream source tag `rust-v0.144.1`. Live CLI probes remain pending; the contract only exposes source-accepted fields.

### Hook Response Contract (`openai.codex-hook-response@1`)

The `./runtime` entrypoint registers a `ProviderContractCatalogEntry` that defines how contributions are validated for Codex:

| Field | Value |
|-------|-------|
| `contractId` | `openai.codex-hook-response` |
| `version` | `1.1.0` |
| `supportedInteractions` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` |

**Blockability:** All five events support blocking responses. SessionStart uses `continue: false` with `stopReason`; the other events use their event-specific block form.

**Composition:** Contributions are collected deterministically. Context appends render as `hookSpecificOutput.additionalContext`; blocks use `decision: "block"` with a non-empty reason; PreToolUse additionally supports `permissionDecision: "deny"` and an allowed `updatedInput` rewrite.

See [Client Hook Response Pipeline](../../docs/architecture/client-hook-responses.md) for the full architecture.

## Native Tools

Capabilities are sourced from `codexCapabilityMap` in `@makaio/contracts`, keeping the capability taxonomy in one canonical location.

| Tool | Friendly Name | Category | Capabilities |
|------|---------------|----------|-------------|
| `bash` | Terminal | System | `shell.execute`, `file.read`, `file.write`, `file.delete`, `network.request`, `process.manage` |
| `patch` | Patch File | Files | `file.write` |

## Served By (Adapters)

| Adapter ID | Package |
|-----------|---------|
| `codex-app-server` | `@makaio/ai-adapters-codex-app-server` — direct integration with the Codex app-server via stdio subprocess |

## Exports

### Main entrypoint (`.`)

| Export | Kind | Description |
|--------|------|-------------|
| `clientDefinition` | `ClientDefinition` | Static client definition (identity, tools, approval policy) |
| `codexPackage` | `MakaioExtension` | Package descriptor for framework extension discovery |
| `CodexClientSessionService` | class | Session normalization service (re-exported from `./runtime`) |
| `CodexClientSubjects` | namespace subjects | Typed bus subjects for `client:codex.*` (re-exported from `./runtime`) |

#### Config Schemas

| Export | Description |
|--------|-------------|
| `CodexConfigSchemas` | Bus-subject schema map for all config hook RPCs |
| `CodexScopeSchema` | Scope enum for Codex configuration |
| `CodexHookEntrySchema` | Single hook entry |
| `CodexNativeCommandHookSchema` | Native command hook definition |
| `CodexNativeHookMatcherGroupSchema` | Hook matcher group |
| `CodexNativeHooksFileSchema` | Full native hooks file structure |
| `CodexScopeHookRecordSchema` | Per-scope hook record |
| `CodexConfigHooksListRequestSchema` / `…ResponseSchema` | List hooks RPC |
| `CodexConfigHooksAddRequestSchema` / `…ResponseSchema` | Add hook RPC |
| `CodexConfigHooksRemoveRequestSchema` / `…ResponseSchema` | Remove hook RPC |
| `AbsolutePathSchema` | Absolute filesystem path validation |

#### Wiring Schemas

| Export | Description |
|--------|-------------|
| `CodexWiringSchemas` | Bus-subject schema map for wiring list/apply/remove RPCs |

### Runtime entrypoint (`./runtime`)

| Export | Kind | Description |
|--------|------|-------------|
| `codexClientRuntimePackage` | `MakaioExtension` | Registers `codex.runtime` namespace and creates the client session service |
| `CodexClientSessionService` | class | Bridges raw `client:codex.hook.received` events into normalized `client.session.*` observations |
| `CodexClientSubjects` | namespace subjects | Typed bus subjects for `client:codex.*` |
| `CODEX_CLIENT_NAMESPACE` | `string` | Fully-qualified namespace domain (`'client:codex'`) |
| `normalizeCodexHook` | function | Normalizes a raw Codex hook payload into a `CodexNormalizedEvent` |
| `codexProviderContractCatalog` | `ProviderContractCatalogEntry` | Provider contract catalog entry for the `openai.codex-hook-response` contract |
| `composeCodexHookResponse` | function | Collects and renders source-verified synchronous hook responses |

### Server entrypoint (`./server`)

Default export is `[codexPackage, codexClientRuntimePackage]` — the array of packages registered when this client is activated as a server entry.

## Installation

`@makaio/client-codex` is a private workspace package used internally by the framework.

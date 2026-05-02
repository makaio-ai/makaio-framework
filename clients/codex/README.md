# @makaio/client-codex

Static client definition and schema library for the OpenAI Codex CLI. This package declares the user-facing identity of the `codex` binary within the framework — its stable ID, native tool catalog with capability tags drawn from the shared `codexCapabilityMap`, hook event map, and Zod schemas covering Codex's hook configuration and wiring RPCs. A separate `./runtime` entrypoint registers the client-native bus namespace and provides the `CodexClientSessionService` that bridges raw hook events into normalized `client.session.*` observations.

## Client Identity

| Field | Value |
|-------|-------|
| `id` | `codex` |
| `name` | `Codex` |
| `description` | OpenAI Codex CLI — an agentic coding assistant |
| `binaryName` | `codex` |
| `minimumVersion` | _(none declared)_ |
| `defaultApprovalPolicy` | `full-access` |
| `defaultProviderId` | `openai-codex` |
| `configIsolation.envVar` | `CODEX_HOME` |
| `configIsolation.defaultPath` | `~/.codex` |

### Runtime Capabilities

| Capability | Value |
|-----------|-------|
| `supportsHooks` | `true` |
| `supportsStatusline` | `false` |
| `supportsSupervisorLaunch` | `true` |
| `supportsManagedBinary` | `false` |

### Hook Events

| Hook Name | Framework Subject |
|-----------|------------------|
| `SessionStart` | `client.session.started` |
| `UserPromptSubmit` | `client.session.userPrompt.submitted` |
| `PreToolUse` | `client.session.tool.pre` |
| `PostToolUse` | `client.session.tool.post` |
| `Stop` | `client.session.turn.completed` |

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

### Server entrypoint (`./server`)

Default export is `[codexPackage, codexClientRuntimePackage]` — the array of packages registered when this client is activated as a server entry.

## Installation

`@makaio/client-codex` is a private workspace package used internally by the framework.

---

*Part of the [Makaio AI Framework](../../README.md)*

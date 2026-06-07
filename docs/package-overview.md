# Package Overview

This file is the repository map for AI agents and maintainers. Read it together with:

- [`../README.md`](../README.md) for the product-level explanation, public entry points, and high-level architecture.
- [`../AGENTS.md`](../AGENTS.md) for required agent behavior, validation commands, and workspace-wide rules.
- [`.agents/policies/`](../.agents/policies/) for area-specific engineering constraints.

Use this document to answer two questions before editing code:

1. Which package or workspace owns the behavior?
2. Which deeper context should be loaded next for the task?

This document intentionally does not replace package READMEs, architecture docs, generated subject docs, or policies. If a
package list is being updated, verify coverage with `yarn workspaces list`; the root workspace `.` is not listed as a
package below.

## Context Routing

Start with the narrowest source that matches the task. Policies extend the rules in `AGENTS.md`; architecture docs explain
system design; subject docs describe bus contracts generated from the codebase.

| Task area                                                           | Start here                                                            | Then load                                                                                                                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New package placement or dependency direction                       | This file, `AGENTS.md`                                                | Relevant area policy, target `package.json` files                                                                                                                                                   |
| Adapter implementation or adapter tests                             | [`adapters/`](#adapters)                                              | [`.agents/policies/adapters.md`](../.agents/policies/adapters.md), [`docs/creating-adapters.md`](creating-adapters.md), [`docs/architecture/adapters/`](architecture/adapters/index.md)             |
| Bus subjects, RPC, pub/sub, or storage-over-bus                     | [`core/contracts`](#core), [`core/bus-core`](#core)                   | [`docs/architecture/bus/`](architecture/bus/index.md), [`docs/subjects/`](subjects/index.md)                                                                                                        |
| Extension contributions, lifecycle, commands, tools, or UI surfaces | [`extensions/`](#extensions), [`packages/kernel`](#layer-1--packages) | [`.agents/policies/extensions.md`](../.agents/policies/extensions.md), [`docs/creating-extensions.md`](creating-extensions.md), [`docs/architecture/extensions/`](architecture/extensions/index.md) |
| CLI, Electron, Electrobun, website, or desktop host work            | [`apps/`](#apps)                                                      | [`.agents/policies/apps.md`](../.agents/policies/apps.md), [`docs/architecture/apps.md`](architecture/apps.md)                                                                                      |
| UI components, hooks, views, design tokens, or shell rendering      | [`ui/`](#ui)                                                          | [`.agents/policies/ui.md`](../.agents/policies/ui.md), package-level source and tests                                                                                                               |
| Storage, Drizzle schema, migrations, or persistent preferences      | [`storage/`](#storage)                                                | [`.agents/policies/migrations.md`](../.agents/policies/migrations.md), [`docs/architecture/bus/storage.md`](architecture/bus/storage.md)                                                            |
| Transports, WebSocket, stdio, cross-process routing                 | [`transports/`](#transports)                                          | [`.agents/policies/transports.md`](../.agents/policies/transports.md), [`docs/architecture/transport.md`](architecture/transport.md)                                                                |
| Provider metadata, model catalogs, clients, credentials             | [`providers/`](#providers), [`clients/`](#clients)                    | [`.agents/policies/providers.md`](../.agents/policies/providers.md), adapter docs when provider behavior affects turns                                                                              |
| SDKs, generated protocol manifests, cross-language conformance      | [`sdks/`](#sdks)                                                      | [`.agents/policies/sdks.md`](../.agents/policies/sdks.md), `sdks/manifest/`, `sdks/conformance/`                                                                                                    |
| Build tooling, validation scripts, Vite or tsdown config            | [`build-tooling/`](#build-tooling)                                    | [`.agents/policies/build-tooling.md`](../.agents/policies/build-tooling.md), root `package.json` scripts                                                                                            |
| Tools or toolsets                                                   | [`core/tools-core`](#core), relevant extension                        | [`.agents/policies/tools.md`](../.agents/policies/tools.md), [`docs/subjects/tool.md`](subjects/tool.md)                                                                                            |

## Source of Truth

When files disagree, use this order:

1. `package.json` and implementation source for current package identity and executable behavior.
2. `AGENTS.md` and `.agents/policies/*` for required engineering constraints.
3. Architecture docs under `docs/architecture/` for intended design.
4. This file for repository navigation and package ownership.
5. `README.md` for product-facing positioning and representative examples.

Generated subject docs under `docs/subjects/` are the best starting point for bus namespace discovery, but generated files
should be regenerated rather than hand-edited when their source contracts change.

## Workspace Coverage

The package inventory below is scoped to Yarn workspaces from `package.json`. It was checked with `yarn workspaces list`;
`yarn workspace list` is not the correct Yarn 4 syntax for listing workspaces.

Non-workspace directories that are still important context include:

- `docs/architecture/` for design explanations.
- `docs/subjects/` for generated bus subject reference.
- `sdks/manifest/` and `sdks/conformance/` for SDK protocol generation and cross-language fixtures.
- `.agents/policies/` for area-specific rules.
- `scripts/` for repo validation, generation, and development automation.

## Workspace Layering

Dependencies flow downward. A package may only depend on packages in its own layer or below.

| Layer | Directories                        | Rule                                                          |
| ----- | ---------------------------------- | ------------------------------------------------------------- |
| 0     | `core/`, `storage/`, `transports/` | Only depend on Layer 0                                        |
| 1     | `packages/`                        | Depend on Layer 0 only — reusable utility libraries           |
| 2     | `subsystems/`                      | Depend on Layer 0 + 1 — standalone domains with own lifecycle |
| 3     | `services/`                        | Depend on Layer 0 + 1 + 2 — orchestrate subsystems            |
| 4     | `apps/`, `runtimes/`, `platforms/` | May depend on anything                                        |

Cross-cutting directories (`adapters/`, `clients/`, `providers/`, `extensions/`, `ui/`, `sdks/`) follow domain-specific rules but respect the layer direction.

## Decision Tree: Where Does a New Package Go?

```text
Does it have zero @makaio deps?           → packages/
Does it depend only on core/?             → packages/
Does it have its own domain + lifecycle?  → subsystems/
Does it orchestrate other subsystems?     → services/
Is it dev/build-only tooling?             → build-tooling/
Is it an app, CLI, or desktop host?       → apps/
```

**Naming conventions:** Top-level directories are plural (`subsystems/`, `services/`). Entries within are singular (`subsystems/adapter/`, `subsystems/workflow/`).

---

## Layer 0 — Core

Foundation types, bus primitives, storage, and transports. No upward dependencies.

Read the relevant policy before changing storage, migrations, or transports. For bus contracts, start from
`core/contracts`, then use `docs/subjects/` and `docs/architecture/bus/` to understand the public message surface.

### `core/`

| Path               | Package              | Description                                                                         |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `core/makaio-core` | `@makaio/core`       | Core types, errors, and context utilities. Foundation for all packages.             |
| `core/bus-core`    | `@makaio/bus-core`   | Type-safe, distributed event bus — pub/sub, RPC, namespaces, scoped/filtered buses. |
| `core/contracts`   | `@makaio/contracts`  | Shared type contracts, Zod schemas, and bus subject namespaces.                     |
| `core/tools-core`  | `@makaio/tools-core` | Tool execution primitives: contracts, typed results, and toolset abstractions.      |

### `storage/`

| Path                  | Package                      | Description                                                                   |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `storage/core`        | `@makaio/storage-core`       | Factory for creating bus-integrated storage namespaces.                       |
| `storage/drizzle`     | `@makaio/storage-drizzle`    | Drizzle ORM extension with runtime SQLite client.                             |
| `storage/handlers`    | `@makaio/storage-handlers`   | Factory functions for Drizzle-backed bus storage handlers.                    |
| `storage/migrations`  | `@makaio/storage-migrations` | Drizzle migration management: schema discovery, aggregation, and application. |
| `storage/preferences` | `@makaio/preferences`        | User preference storage with localStorage, Drizzle, and hybrid backends.      |

### `transports/`

| Path                         | Package                                 | Description                                                    |
| ---------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `transports/ws`              | `@makaio/bus-transport-websocket`       | WebSocket transport with HMAC auth, E2E encryption, and relay. |
| `transports/stdio`           | `@makaio/bus-transport-stdio`           | Stdio JSONL transport for cross-process bus communication.     |
| `transports/message-channel` | `@makaio/bus-transport-message-channel` | MessageChannel transport for SharedWorker and iframe contexts. |

---

## Layer 1 — Packages

Reusable utility libraries. Depend only on Layer 0.

For generic infrastructure packages, also read [`.agents/policies/packages.md`](../.agents/policies/packages.md). For
shared service lifecycle behavior, inspect `packages/service-base` before adding package-local lifecycle abstractions.

| Path                        | Package                    | Description                                                                         |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `packages/utils`            | `@makaio/utils`            | Utility primitives: DeferredPromise, timeouts, JSON extraction. Zero internal deps. |
| `packages/file-watcher`     | `@makaio/file-watcher`     | Polling file watcher with cursor-based change tracking. Zero internal deps.         |
| `packages/machine-identity` | `@makaio/machine-identity` | Persistent ECDH + signing key pairs for device authentication. Zero internal deps.  |
| `packages/type-lens`        | `@makaio/type-lens`        | TypeScript AST indexer and symbol graph engine. Zero internal deps.                 |
| `packages/subprocess`       | `@makaio/subprocess`       | Subprocess lifecycle and JSONL-framed JSON-RPC communication.                       |
| `packages/expression`       | `@makaio/expression`       | Jexl-based expression evaluation and template interpolation for workflows.          |
| `packages/rules`            | `@makaio/rules`            | Condition schemas and rule evaluator using expressions.                             |
| `packages/hooks`            | `@makaio/hooks`            | Typed interceptors for MakaioBus message lifecycle (PreTurn, PostTurn, PreToolUse). |
| `packages/inbound-hooks`    | `@makaio/inbound-hooks`    | Fail-open ingress helpers for native hook events.                                   |
| `packages/service-base`     | `@makaio/service-base`     | Abstract base class for Makaio bus services (init/start/stop lifecycle).            |
| `packages/kernel`           | `@makaio/kernel`           | Runtime extension orchestration: ExtensionCoordinator, boot sequencing, providers.  |
| `packages/oauth-core`       | `@makaio/oauth-core`       | OAuth state management primitives for framework auth flows.                         |
| `packages/providers`        | `@makaio/providers`        | Platform-specific ConfigProvider and WebhookProvider implementations.               |
| `packages/bus-server`       | `@makaio/bus-server`       | WebSocket server for MakaioBus message routing with HMAC auth.                      |
| `packages/bus-server-vite`  | `@makaio/bus-server-vite`  | Vite dev-server plugin that co-boots the full Makaio Node runtime.                  |
| `packages/setup`            | `@makaio/setup`            | Guided first-run setup flow: client detection, consent, binary install.             |
| `packages/test-utils`       | `@makaio/test-utils`       | Vitest harnesses: mock bus factory and SQLite database lifecycle helpers.           |
| `packages/framework`        | `@makaio/framework`        | Pre-built distribution bundle re-exporting all framework public APIs.               |

---

## Layer 2 — Subsystems

Standalone domains with own lifecycle. Depend on Layer 0 + 1.

Subsystems own domain lifecycle without becoming top-level application services. If a change starts orchestrating several
subsystems together, check whether it belongs in `services/` instead.

| Path                                   | Package                                       | Description                                                                     |
| -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `subsystems/adapter`                   | `@makaio/subsystem-adapter`                   | Adapter contribution loading, config lifecycle, and runtime registry.           |
| `subsystems/client`                    | `@makaio/subsystem-client`                    | Managed client runtime/binary services, session config, and profile management. |
| `subsystems/git`                       | `@makaio/subsystem-git`                       | Git service, repository queries, working-tree cache, and filesystem watching.   |
| `subsystems/workflow-engine`           | `@makaio/subsystem-workflow-engine`           | DAG workflow executor with checkpoint recovery, step runners, and OTel tracing. |
| `subsystems/mcp-http-server`           | `@makaio/subsystem-mcp-http-server`           | MCP HTTP/stdio bridge routing tool calls from subprocess adapters to the bus.   |
| `subsystems/native-session-supervisor` | `@makaio/subsystem-native-session-supervisor` | PTY process spawning, tracking, and lifecycle management for native sessions.   |

---

## Layer 3 — Services

Application services that orchestrate subsystems. Depend on Layer 0 + 1 + 2.

Services are the right place for cross-domain runtime orchestration. For bus subjects emitted or handled by services, use
`docs/subjects/services/` as the first contract index.

| Path                       | Package                            | Description                                                                                     |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `services/core`            | `@makaio/services-core`            | Primary service layer: session orchestration, message routing, agent management, tool approval. |
| `services/log-import`      | `@makaio/services-log-import`      | Central registry for adapter-contributed log importers and import orchestration.                |
| `services/package-manager` | `@makaio/services-package-manager` | Yarn-backed extension package install/uninstall and registry management.                        |

---

## Layer 4 — Applications and Runtimes

Top-level consumers. May depend on anything.

Application hosts compose runtime packages and UI, but shared desktop behavior should generally live in `apps/host-shared`.
Read [`.agents/policies/apps.md`](../.agents/policies/apps.md) before changing Electron or Electrobun host code.

### `apps/`

| Path               | Package                  | Description                                         |
| ------------------ | ------------------------ | --------------------------------------------------- |
| `apps/cli`         | `@makaio/cli`            | Headless CLI server + bus client.                   |
| `apps/electron`    | `@makaio/electron`       | Electron desktop host.                              |
| `apps/electrobun`  | `@makaio/electrobun`     | Electrobun desktop host (Bun-native, experimental). |
| `apps/host-shared` | `@makaio/host-shared`    | Shared desktop host boot/rendering logic.           |
| `apps/mcp-server`  | `@makaio/app-mcp-server` | MCP stdio bridge to a running Makaio server.        |
| `apps/public-api`  | `@makaio/public-api`     | Public HTTP API for release metadata and artifacts. |
| `apps/website`     | `@makaio/website`        | Framework documentation and marketing website.      |

### `runtimes/`

| Path            | Package                | Description                                                    |
| --------------- | ---------------------- | -------------------------------------------------------------- |
| `runtimes/bun`  | `@makaio/runtime-bun`  | Bun host assembly helpers.                                     |
| `runtimes/node` | `@makaio/runtime-node` | Node host assembly: `bootMakaioRuntime()`, discovery, DB init. |

### `platforms/`

| Path              | Package                  | Description                                 |
| ----------------- | ------------------------ | ------------------------------------------- |
| `platforms/macos` | `@makaio/platform-macos` | macOS platform-specific native integration. |

---

## Cross-Cutting Domains

These directories follow domain-specific conventions but respect the layer direction.

Cross-cutting directories are not exempt from dependency direction. Their policies define the local ownership rules for
contracts, lifecycle, generated metadata, and host integration.

### `adapters/`

AI adapter implementations. Each wraps a vendor client (Claude Code, Codex, Gemini, etc.).

Read [`.agents/policies/adapters.md`](../.agents/policies/adapters.md) and
[`docs/creating-adapters.md`](creating-adapters.md) before editing adapter contracts or provider turn behavior.

| Path                                          | Package                                     | Description                                                          |
| --------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `adapters/core`                               | `@makaio/ai-adapters-core`                  | Base classes, conformance test suite, shared adapter infrastructure. |
| `adapters/shared/acp-client`                  | `@makaio/ai-adapters-acp-client`            | Shared ACP (Agent Communication Protocol) client.                    |
| `adapters/shared/claude-shared`               | `@makaio/ai-adapters-claude-shared`         | Shared infrastructure for Claude protocol adapters.                  |
| `adapters/shared/claude-process-shared`       | `@makaio/ai-adapters-claude-process-shared` | Process utilities shared between Claude CLI and tmux adapters.       |
| `adapters/shared/stream-session`              | `@makaio/ai-adapters-stream-session`        | Shared infrastructure for stream-based adapter implementations.      |
| `adapters/implementations/anthropic-sdk`      | `@makaio/adapter-anthropic-sdk`             | Anthropic SDK adapter (official streaming API).                      |
| `adapters/implementations/claude-agent-sdk`   | `@makaio/adapter-claude-agent-sdk`          | Claude Agent SDK adapter.                                            |
| `adapters/implementations/claude-code-cli`    | `@makaio/adapter-claude-code-cli`           | Claude Code CLI adapter.                                             |
| `adapters/implementations/claude-code-tmux`   | `@makaio/adapter-claude-code-tmux`          | Claude Code tmux adapter.                                            |
| `adapters/implementations/codex-app-server`   | `@makaio/adapter-codex-app-server`          | OpenAI Codex App-Server adapter.                                     |
| `adapters/implementations/cursor-sdk`         | `@makaio/adapter-cursor-sdk`                | Cursor SDK adapter.                                                  |
| `adapters/implementations/gemini-sdk`         | `@makaio/adapter-gemini-sdk`                | Gemini SDK adapter.                                                  |
| `adapters/implementations/github-copilot-sdk` | `@makaio/adapter-github-copilot-sdk`        | GitHub Copilot SDK adapter.                                          |
| `adapters/implementations/openai-node`        | `@makaio/adapter-openai-node`               | OpenAI Node SDK adapter.                                             |
| `adapters/implementations/pi-sdk`             | `@makaio/adapter-pi-sdk`                    | Pi SDK adapter.                                                      |
| `adapters/implementations/qwen-acp`           | `@makaio/adapter-qwen-acp`                  | Qwen ACP adapter.                                                    |

### `clients/`

External tool client integrations.

Clients model external installed tools and runtime binaries. Provider identity and model metadata usually belong in
`providers/`; adapter turn behavior belongs in `adapters/`.

| Path                     | Package                         | Description                        |
| ------------------------ | ------------------------------- | ---------------------------------- |
| `clients/claude-code`    | `@makaio/client-claude-code`    | Claude Code client integration.    |
| `clients/codex`          | `@makaio/client-codex`          | OpenAI Codex client integration.   |
| `clients/cursor`         | `@makaio/client-cursor`         | Cursor client integration.         |
| `clients/gemini`         | `@makaio/client-gemini`         | Gemini client integration.         |
| `clients/github-copilot` | `@makaio/client-github-copilot` | GitHub Copilot client integration. |
| `clients/qwen`           | `@makaio/client-qwen`           | Qwen client integration.           |

### `providers/`

Provider metadata packages: model catalogs, capability tags, credential resolution.

Read [`.agents/policies/providers.md`](../.agents/policies/providers.md) before changing provider packages. These packages
should stay metadata-focused and avoid runtime orchestration.

| Path                       | Package                           | Description              |
| -------------------------- | --------------------------------- | ------------------------ |
| `providers/alibaba`        | `@makaio/provider-alibaba`        | Alibaba Cloud provider.  |
| `providers/anthropic`      | `@makaio/provider-anthropic`      | Anthropic provider.      |
| `providers/cursor`         | `@makaio/provider-cursor`         | Cursor provider.         |
| `providers/github-copilot` | `@makaio/provider-github-copilot` | GitHub Copilot provider. |
| `providers/google`         | `@makaio/provider-google`         | Google provider.         |
| `providers/kimi`           | `@makaio/provider-kimi`           | Kimi provider.           |
| `providers/nanogpt`        | `@makaio/provider-nanogpt`        | NanoGPT provider.        |
| `providers/openai`         | `@makaio/provider-openai`         | OpenAI provider.         |
| `providers/openai-codex`   | `@makaio/provider-openai-codex`   | OpenAI Codex provider.   |
| `providers/opencode-go`    | `@makaio/provider-opencode-go`    | OpenCode Go provider.    |
| `providers/openrouter`     | `@makaio/provider-openrouter`     | OpenRouter provider.     |
| `providers/qwen`           | `@makaio/provider-qwen-acp`       | Qwen provider.           |
| `providers/z-ai`           | `@makaio/provider-z-ai`           | Z.ai provider.           |

### `extensions/`

Framework-shipped extensions contributing tools, hooks, and UI surfaces.

Read [`.agents/policies/extensions.md`](../.agents/policies/extensions.md),
[`docs/creating-extensions.md`](creating-extensions.md), and
[`docs/architecture/extensions/`](architecture/extensions/index.md) before changing extension manifests or lifecycle.

| Path                                | Package                                    | Description                                     |
| ----------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| `extensions/account-manager`        | `@makaio/extension-account-manager`        | Account management extension.                   |
| `extensions/claude-code-statusline` | `@makaio/extension-claude-code-statusline` | Claude Code status line extension.              |
| `extensions/client-commands`        | `@makaio/extension-client-commands`        | Client command contributions.                   |
| `extensions/client-hooks`           | `@makaio/extension-client-hooks`           | Client lifecycle hooks.                         |
| `extensions/coderabbit`             | `@makaio/extension-coderabbit`             | CodeRabbit code review integration.             |
| `extensions/filesystem`             | `@makaio/extension-filesystem`             | Filesystem tool extension with path validation. |
| `extensions/git-hooks`              | `@makaio/extension-git-hooks`              | Native Git hook integration.                    |
| `extensions/opencode`               | `@makaio/extension-opencode`               | OpenCode extension.                             |
| `extensions/pin-message`            | `@makaio/extension-pin-message`            | Pin message extension.                          |
| `extensions/pr-entity`              | `@makaio/extension-pr-entity`              | Pull request entity extension.                  |
| `extensions/prompt`                 | `@makaio/extension-prompt`                 | Prompt management extension.                    |
| `extensions/review`                 | `@makaio/extension-review`                 | Code review extension.                          |
| `extensions/reviewer-copilot`       | `@makaio/reviewer-copilot`                 | Copilot reviewer extension.                     |
| `extensions/shell`                  | `@makaio/extension-shell`                  | Shell execution tool extension.                 |
| `extensions/subagent`               | `@makaio/extension-subagent`               | Subagent communication tool and state manager.  |
| `extensions/telemetry-langfuse`     | `@makaio/extension-telemetry-langfuse`     | Langfuse trace exporter extension.              |
| `extensions/telemetry-otel`         | `@makaio/extension-telemetry-otel`         | OpenTelemetry trace exporter extension.         |
| `extensions/workflow`               | `@makaio/extension-workflow`               | Workflow CLI extension.                         |

### `ui/`

React-based UI layer: design tokens, components, hooks, and composed views.

Read [`.agents/policies/ui.md`](../.agents/policies/ui.md) before UI work. The dependency order is kernel, theme,
components, hooks, then views.

| Path            | Package                 | Description                                                    |
| --------------- | ----------------------- | -------------------------------------------------------------- |
| `ui/kernel`     | `@makaio/ui-kernel`     | TypeScript contracts, registries, and schemas for UI packages. |
| `ui/theme`      | `@makaio/ui-theme`      | Design tokens and Aura theme (SCSS-only package).              |
| `ui/components` | `@makaio/ui-components` | Presentational React components (no hooks, no bus).            |
| `ui/hooks`      | `@makaio/ui-hooks`      | React hooks, Zustand stores, and bus-aware orchestration.      |
| `ui/views`      | `@makaio/ui-views`      | Composed React views and shell surfaces for renderers.         |

### `sdks/`

Public SDK surface for external consumers.

Read [`.agents/policies/sdks.md`](../.agents/policies/sdks.md) before SDK work. Generated protocol files are driven by
`sdks/manifest/` and shared conformance fixtures under `sdks/conformance/`.

| Path              | Package             | Description                                                   |
| ----------------- | ------------------- | ------------------------------------------------------------- |
| `sdks/typescript` | `@makaio/sdk`       | TypeScript SDK for the Makaio bus protocol.                   |
| `sdks/agent-sdk`  | `@makaio/agent-sdk` | Claude Agent SDK-compatible interface to all Makaio adapters. |

### `build-tooling/`

Read [`.agents/policies/build-tooling.md`](../.agents/policies/build-tooling.md) before changing validation, bundling, or
Vite/tsdown helpers.

| Path            | Package                 | Description                                             |
| --------------- | ----------------------- | ------------------------------------------------------- |
| `build-tooling` | `@makaio/build-tooling` | Shared Vite/tsdown configs for extensions and adapters. |

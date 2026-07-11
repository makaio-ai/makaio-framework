# @makaio/ai-adapters-qwen-acp

Qwen Code CLI adapter for the Makaio AI framework. Integrates with Alibaba's
Qwen Code agent by spawning the `qwen` CLI binary and communicating over the
Agent Client Protocol (ACP) via stdio rather than calling a provider API
directly.

## Quick Start

The implementation is not currently contributed by its runtime package. Qwen
OAuth is discontinued, and no remaining Qwen authentication mode yet has a
connector-owned isolated lease. Direct connector tests may provide an isolated
auth snapshot, but production discovery does not advertise the adapter as
startable.

## Adapter Identity

| Field | Value |
|-------|-------|
| `adapterName` | `'qwen-acp'` |
| `protocol` | SDK-native ACP subprocess (no HTTP protocol) |
| `providers` | None until an isolated authentication path is implemented |
| `clients` | `[{ id: 'qwen', version: '^0.1.0' }]` |

## Architecture

Three-layer design matching the framework adapter contract:

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Domain | `QwenAcpAdapter` | Handles `adapter.*` bus subjects, lifecycle |
| Agent | `QwenAcpAgent` | Wires connector events to global `agent.*` subjects |
| Connector | `QwenAcpConnector` | Spawns `qwen --acp`, manages ACP session |

The connector spawns the `qwen` binary with `--acp` and communicates over stdio
using the `@agentclientprotocol/sdk`. The shared `@makaio/ai-adapters-acp-client`
package provides the subprocess spawn, ndjson stream bridge, and terminal
manager used by this connector.

Key connector behaviors:
- Lazy ACP session initialization; idempotent `initialize()` call
- System prompt injected via a temporary markdown file (`QWEN_SYSTEM_MD` env var)
- Model and CWD are bound at subprocess spawn; in-place changes are not supported
  (`changeModelInPlace` and `changeCwdInPlace` both return `false`)
- ACP delegates all tool execution to the client — no `nativeTools` are declared
- Permission requests flow through the standard `AgentSubjects.toolApprove` bus subject
- Filesystem read/write gated through the tool approval flow

## Capabilities

Runtime capabilities declared by the adapter:

| Capability | Meaning |
|------------|---------|
| `tools` | Tool approval via ACP permission requests |
| `streaming` | Incremental message and thought chunk events |
| `systemPrompt:override` | Replace the system prompt via `QWEN_SYSTEM_MD` |

## Configuration

Provider configuration is resolved from the `ProviderContext` supplied on
`adapter.startAgent`. The `QwenAcpProviderConfigSchema` defines the
provider-specific options:

| Field | Type | Description |
|-------|------|-------------|
| `approvalMode` | `'plan' \| 'default' \| 'auto-edit' \| 'yolo'` (optional) | How tool approval is handled by the CLI |
| `authType` | `'openai' \| 'anthropic' \| 'qwen-oauth' \| 'gemini' \| 'vertex-ai'` (optional) | Authentication method for the underlying model provider |

The `qwen` binary is resolved in this priority order:
1. Exact managed/global binary selected by the client subsystem
2. `qwen` on PATH when central resolution deliberately returns no exact path

Default timeouts:

| Phase | Default |
|-------|---------|
| `initialization` | 30 s |
| `acknowledgement` | 30 s |
| `completion` | 60 s |
| `toolApproval` | 5 s |
| `eventWait` | 3 s |

## Usage Telemetry

`agent.usage` is a consolidated prompt-turn aggregate: the connector
accumulates the running `_meta.usage` totals from each message chunk
(last-wins) and flushes them once per turn, including error paths. ACP
reports no monetary amount and no provider call ID, so `cost` and
`llmCallId` are never set. See
[Usage & Provenance](../../../docs/architecture/adapters/usage-and-provenance.md).

## Conformance Testing

```typescript
import { createTestConfig } from '@makaio/ai-adapters-qwen-acp';

const config = await createTestConfig();
```


## File Index

| File | Purpose |
|------|---------|
| `src/adapter.ts` | `QwenAcpAdapter` and `createQwenAcpAdapter` factory |
| `src/agent.ts` | `QwenAcpAgent` — event routing layer |
| `src/connector.ts` | `QwenAcpConnector` — ACP subprocess bridge |
| `src/turn.ts` | `QwenAcpTurn` — turn state machine |
| `src/tool-handling.ts` | Tool approval bridging utilities |
| `src/tool-execution.ts` | ACP filesystem read/write execution |
| `src/permission.ts` | Maps Makaio approval responses to ACP permission outcomes |
| `src/system-prompt.ts` | System prompt lifecycle and reinitialisation logic |
| `src/provider.ts` | Empty production provider declaration and ambient-auth scrub set |
| `src/config.ts` | `QwenAcpConfig` — adapter config factory |
| `src/schemas.ts` | `QwenAcpProviderConfigSchema` |
| `src/constants.ts` | `QwenAcpAdapterName`, `DefaultModel`, `DEFAULT_TIMEOUTS` |
| `src/types.ts` | `QwenAcpConnectorConfig` type |
| `src/definition.ts` | Internal adapter definition consumed by the package descriptor |
| `src/package.ts` | Unavailable package descriptor with no production contributions |
| `src/server.ts` | Server entrypoint that re-exports the package descriptor as default |
| `src/namespaces/` | Bus namespace (`adapter:qwen-acp`), subjects, and event schemas |
| `src/utils/` | Utility functions (CLI args builder, prompt builder, MCP server mapping) |

## Installation

This is a private workspace package. It is not published to npm and is only
available from this source workspace.

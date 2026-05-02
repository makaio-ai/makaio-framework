# @makaio/ai-adapters-qwen-acp

Qwen Code CLI adapter for the Makaio AI framework. Integrates with Alibaba's
Qwen Code agent by spawning the `qwen` CLI binary and communicating over the
Agent Client Protocol (ACP) via stdio rather than calling a provider API
directly.

## Quick Start

```typescript
import { createQwenAcpAdapter } from '@makaio/ai-adapters-qwen-acp';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

const adapter = await createQwenAcpAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
});
```

## Adapter Identity

| Field | Value |
|-------|-------|
| `adapterName` | `'qwen-acp'` |
| `protocol` | `'openai'` |
| `providers` | `qwen-oauth` |
| `defaultPresetId` | `'qwen-oauth'` |
| `defaultModel` | `'qwen3.5-plus(openai)'` |
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

Conformance-test capabilities returned by `createTestConfig()`:

| Feature | Supported |
|---------|-----------|
| `supportsReplace` | Yes |
| `supportsInterrupt` | Yes — ACP `session/cancel` |
| `supportsUsageMetrics` | Yes — per-turn tokens from `agent_message_chunk._meta.usage` |

## Configuration

Provider configuration is resolved from the `ProviderContext` supplied on
`adapter.startAgent`. The `QwenAcpProviderConfigSchema` defines the
provider-specific options:

| Field | Type | Description |
|-------|------|-------------|
| `binaryPath` | `string` (optional) | Path to `qwen` CLI binary (default: `"qwen"` via PATH) |
| `approvalMode` | `'plan' \| 'default' \| 'auto-edit' \| 'yolo'` (optional) | How tool approval is handled by the CLI |
| `authType` | `'openai' \| 'anthropic' \| 'qwen-oauth' \| 'gemini' \| 'vertex-ai'` (optional) | Authentication method for the underlying model provider |

The `qwen` binary is resolved in this priority order:
1. Explicit `providerConfig.binaryPath`
2. Managed binary resolved from the provider context
3. `qwen` on PATH

Default timeouts:

| Phase | Default |
|-------|---------|
| `initialization` | 30 s |
| `acknowledgement` | 30 s |
| `completion` | 60 s |
| `toolApproval` | 5 s |
| `eventWait` | 3 s |

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
| `src/provider.ts` | Provider IDs and preset configuration |
| `src/provider.fetcher.ts` | Model fetcher for provider resolution |
| `src/config.ts` | `QwenAcpConfig` — adapter config factory |
| `src/schemas.ts` | `QwenAcpProviderConfigSchema` |
| `src/constants.ts` | `QwenAcpAdapterName`, `DefaultModel`, `DEFAULT_TIMEOUTS` |
| `src/types.ts` | `QwenAcpConnectorConfig` type |
| `src/definition.ts` | Internal adapter definition consumed by the package descriptor |
| `src/package.ts` | `MakaioExtension` package descriptor with `adapters[]` contribution |
| `src/server.ts` | Server entrypoint that re-exports the package descriptor as default |
| `src/conformance.ts` | `createTestConfig` for the shared conformance test suite |
| `src/namespaces/` | Bus namespace (`adapter:qwen-acp`), subjects, and event schemas |
| `src/utils/` | Utility functions (CLI args builder, prompt builder, MCP server mapping) |

## Installation

This is a private workspace package. It is not published to npm and is only
available from this source workspace.

---

*Part of the [Makaio AI Framework](../../../README.md)*

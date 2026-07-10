# @makaio/adapter-anthropic-sdk

Anthropic SDK AI adapter for the Makaio framework. Provides direct access to Claude models via the `@anthropic-ai/sdk` streaming API.

## Quick Start

```typescript
import { createAnthropicSdkAdapter } from '@makaio/adapter-anthropic-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

const adapter = await createAnthropicSdkAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
});
```

## Architecture

Three-layer design matching the framework adapter contract:

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Domain | `AnthropicSdkAdapter` | Handles `adapter.*` bus subjects, lifecycle |
| Agent | `AnthropicSdkAgent` | Handles `agent.*` subjects, routes connector events |
| Connector | `AnthropicSdkConnector` | Owns the SDK streaming session, tool calling |

The connector drives an `AnthropicSdkSession` and `AnthropicSdkConnectorTurn` pair
for each user turn, streaming events into the framework event bus.

## Configuration

Provider configuration is resolved from the `ProviderContext` supplied on
`adapter.startAgent` and the canonical provider definitions in `provider.ts`.
The public package root does not expose a config factory for callers to use
directly.

Provider settings may set `requestCorrelationHeaders: "factory-v1"` when the
configured `baseUrl` targets a trusted Factory Gateway. The adapter then
projects only the content-free `SessionContext.requestCorrelation` allowlist
plus runtime-owned session, message, and per-request LLM-call IDs to
`x-factory-*` headers. The option is disabled by default so these identifiers
are never sent to arbitrary Anthropic-compatible endpoints.

Runtime discovery loads `@makaio/adapter-anthropic-sdk/server`, whose
default export is a `MakaioExtension` package descriptor with an `adapters[]`
contribution.

## Tool Approval

Tool approval is wired internally by the agent layer. The connector emits the
scoped `tool_approval` RPC, and `AnthropicSdkAgent` forwards it to the global
`AgentSubjects.toolApprove` subject with the full approval context
(`adapterId`, `adapterName`, `agentId`, `adapterSessionId`, and `sessionId`).

## Capabilities

Runtime capabilities declared by the adapter:

| Capability | Meaning |
|------------|---------|
| `tools` | Tool/function calling support |
| `streaming` | Incremental stream events |
| `systemPrompt:override` | Replace/set the system prompt |
| `systemPrompt:append` | Append to the adapter's default system prompt |

Conformance-test capabilities returned by `createTestConfig()`:

| Feature | Supported |
|---------|-----------|
| `supportsReplace` | Yes — streaming replace delivery mode |
| `supportsInterrupt` | Yes — `connector.interrupt()` |
| `supportsUsageMetrics` | Yes — token usage tracked via stream events |

## Conformance Testing

```typescript
import { createTestConfig } from '@makaio/adapter-anthropic-sdk';

// Returns a ConformanceTestConfig ready for the shared adapter test suite
const config = await createTestConfig();
```

## File Index

| File | Purpose |
|------|---------|
| `src/adapter.ts` | `AnthropicSdkAdapter` and `createAnthropicSdkAdapter` factory |
| `src/agent.ts` | `AnthropicSdkAgent` — event routing layer |
| `src/connector.ts` | `AnthropicSdkConnector` — SDK streaming bridge |
| `src/session.ts` | `AnthropicSdkSession` — session state for a single agent run |
| `src/turn.ts` | `AnthropicSdkConnectorTurn` — turn state machine for one user/assistant exchange |
| `src/stream-bridge.ts` | Streaming event parsing bridge |
| `src/provider.ts` | Provider presets and model configuration |
| `src/config.ts` | Internal adapter config factory |
| `src/schemas.ts` | `AnthropicSdkProviderConfigSchema` and credential schema |
| `src/tool-handling.ts` | Tool approval bridging and tool format conversion |
| `src/definition.ts` | Internal adapter definition consumed by the package descriptor |
| `src/package.ts` | `MakaioExtension` package descriptor with `adapters[]` contribution |
| `src/server.ts` | Server entrypoint that re-exports the package descriptor as default |
| `src/namespaces/` | Bus namespace, subjects, and event schemas |
| `src/types/` | Internal type definitions |
| `src/utils/` | Utility functions (message history, error classification, etc.) |

# @makaio/ai-adapters-pi-sdk

Pi coding agent SDK adapter for the Makaio AI framework. Wraps the
`@mariozechner/pi-coding-agent` SDK — specifically `createAgentSession()` +
`session.prompt()` + `session.subscribe()` — and bridges its procedural agentic
loop into the Makaio three-layer adapter contract.

## Quick Start

```typescript
import { createPiSdkAdapter } from '@makaio/ai-adapters-pi-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

const adapter = await createPiSdkAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
});
```

## Adapter Identity

| Field | Value |
|-------|-------|
| `adapterName` | `'pi-sdk'` |
| `protocol` | `'anthropic'` |
| `providers` | `anthropic`, `openai`, `opencode-go` |
| `defaultPresetId` | `'anthropic'` |
| `defaultModel` | `'claude-sonnet-4-6'` |

## Architecture

Three-layer design matching the framework adapter contract:

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Domain | `PiAdapter` | Handles `adapter.*` bus subjects, lifecycle |
| Agent | `PiAgent` | Wires connector events to global `agent.*` subjects |
| Connector | `PiConnector` | Owns the Pi SDK session, model registry, tool bridging |

Pi SDK manages its own agentic loop. `session.prompt()` is a single async call
that runs the full turn — including all tool round-trips — before resolving,
making this a procedural connector (extends `ProceduralAgentConnector`) rather
than a streaming one.

Key connector behaviors:
- Lazy session initialization on first `start()` or `sendMessage()` call
- Tool approval bridged through Pi's `agent.beforeToolCall` hook
- Mid-session model switching via `session.setModel()` (`changeModelInPlace` returns `true`)
- CWD is bound at session creation (`changeCwdInPlace` always returns `false`)
- Thinking level maps from Makaio `AIReasoningLevel` to Pi's `ThinkingLevel`

Pi owns session history and compaction, so `PiAgent` returns `true` from
`supportsNativeResume()` — Makaio does not inject prior message history into
follow-up turns.

## Capabilities

Runtime capabilities declared by the adapter:

| Capability | Meaning |
|------------|---------|
| `tools` | Makaio registry tools forwarded to Pi as custom tools |
| `streaming` | Incremental text and reasoning delta events |
| `systemPrompt:override` | Replace the system prompt |
| `systemPrompt:append` | Append to the adapter's default system prompt |
| `modelSwitchInSession` | Model can be switched mid-session via `session.setModel()` |

Native tools handled by the Pi SDK internally (not through the Makaio tool
approval flow unless configured otherwise): `read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`.

Conformance-test capabilities returned by `createTestConfig()`:

| Feature | Supported |
|---------|-----------|
| `supportsReplace` | Yes |
| `supportsInterrupt` | Yes |
| `supportsUsageMetrics` | Yes — token usage from Pi's `usage` event |

## Configuration

Provider configuration is resolved from the `ProviderContext` supplied on
`adapter.startAgent`. The `PiSdkProviderConfigSchema` defines the
provider-specific options:

| Field | Type | Description |
|-------|------|-------------|
| `noTools` | `'all' \| 'builtin'` (optional) | Tool suppression mode at session creation |

Credentials are resolved via the provider context's `credentialRefs` at session
initialization time. An `apiKey` credential ref is injected into Pi's
`AuthStorage` when present; endpoint overrides can be supplied via
`providerContext.endpointOverrides`.

Default timeouts:

| Phase | Default |
|-------|---------|
| `initialization` | 60 s |
| `acknowledgement` | 120 s |
| `completion` | 600 s |
| `toolApproval` | 120 s |
| `eventWait` | 30 s |

## Peer Dependencies

```
@mariozechner/pi-agent-core  >=0.72.0
@mariozechner/pi-ai          >=0.72.0
@mariozechner/pi-coding-agent >=0.72.0
```

## Conformance Testing

```typescript
import { createTestConfig } from '@makaio/ai-adapters-pi-sdk/test';

// Uses the OpenCode Go gateway to avoid direct API costs
const config = await createTestConfig();
```

## File Index

| File | Purpose |
|------|---------|
| `src/adapter.ts` | `PiAdapter` and `createPiSdkAdapter` factory |
| `src/agent.ts` | `PiAgent` — event routing layer |
| `src/connector.ts` | `PiConnector` — Pi SDK session bridge |
| `src/session.ts` | `PiConnectorSession` — session state for a single agent run |
| `src/turn.ts` | `PiConnectorTurn` — turn state machine |
| `src/tool-conversion.ts` | Makaio → Pi tool format conversion and registry fetch |
| `src/tool-handling.ts` | Tool approval bridging |
| `src/provider-registry.ts` | Pi `ModelRegistry` registration and `REASONING_TO_THINKING` map |
| `src/provider.ts` | Provider IDs and preset configuration |
| `src/config.ts` | `PiSdkConfig` — adapter config factory |
| `src/schemas.ts` | `PiSdkProviderConfigSchema` |
| `src/constants.ts` | `PiSdkAdapterName`, `DefaultModel`, `DEFAULT_TIMEOUTS` |
| `src/definition.ts` | Internal adapter definition consumed by the package descriptor |
| `src/package.ts` | `MakaioExtension` package descriptor with `adapters[]` contribution |
| `src/server.ts` | Server entrypoint that re-exports the package descriptor as default |
| `src/conformance.ts` | `createTestConfig` for the shared conformance test suite |
| `src/namespaces/` | Bus namespace (`adapter:piSdk`), subjects, and event schemas |
| `src/types/` | Internal type definitions (`PiConnectorConfig`, `PiThinkingLevel`) |

## Installation

This is a private workspace package. It is not published to npm and is only
available from this source workspace.

---

*Part of the [Makaio AI Framework](../../../README.md)*

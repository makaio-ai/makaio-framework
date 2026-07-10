# @makaio/adapter-github-copilot-sdk

> [!IMPORTANT]
> Since GitHub Copilot [changed its pricing model](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/),
> this provider package is currently no longer actively maintained.

GitHub Copilot SDK adapter for the Makaio AI framework.

## Quick Start

```typescript
import {
  createGitHubCopilotSDKAdapter,
  GitHubCopilotAdapter,
} from '@makaio/adapter-github-copilot-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

// Using the factory function (recommended)
const adapter = await createGitHubCopilotSDKAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
});

// Or using the class directly
const directAdapter = new GitHubCopilotAdapter();
await directAdapter.init();

const directResult = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: directAdapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
});
```

## Architecture

This adapter follows the three-layer architecture pattern:

```
GitHubCopilotAdapter extends AIAdapter
    -> creates via agentFactory()
GitHubCopilotAgent extends AIAgent
    -> receives connector via connectorFactory()
GitHubCopilotConnector extends AIAgentConnector
```

**Layers:**

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Adapter | `GitHubCopilotAdapter` | Factory for agents, handles `adapter.startAgent` RPC |
| Agent | `GitHubCopilotAgent` | Wires events to global bus, manages lifecycle |
| Connector | `GitHubCopilotConnector` | SDK-level bridge to GitHub Copilot |

**Session/Turn Management:**

| Class | Purpose |
|-------|---------|
| `CopilotConnectorSession` | Session lifecycle management |
| `CopilotConnectorTurn` | Individual turn handling |
| `UserMessageQueue` | Internal connector queue from adapter core |

## Capabilities

- `tools` - Tool/function calling support
- `systemPrompt:override` - Replace/set the system prompt
- `systemPrompt:append` - Append to the adapter's default system prompt
- Tool approval workflow via `registerToolApprovalHandler`
- Replace and interrupt delivery modes
- Model metadata from the model registry and canonical provider definitions

**Note:** Runtime model lists come from the canonical GitHub Copilot provider
definition and model registry, not provider config. Registry generation can use
`provider.fetcher.ts`, which asks the Copilot SDK for models using the SDK's own
authentication flow.

## Usage Telemetry

`agent.usage` is emitted per `assistant.usage` event, i.e. at sub-turn
granularity — one turn may produce several events. The SDK reports no
monetary amount and no provider call ID, so `cost` and `llmCallId` are never
set. `inputTokens` reflects the full LLM prompt including Copilot's built-in
tool schemas and is deliberately not used for context-window estimates. See
[Usage & Provenance](../../../docs/architecture/adapters/usage-and-provenance.md).

## Exports

### Adapter

| Export | Description |
|--------|-------------|
| `GitHubCopilotAdapter` | Main adapter class |
| `createGitHubCopilotSDKAdapter` | Factory function (creates and initializes) |
| `GitHubCopilotSdkAdapterName` | Adapter identifier constant |

### Agent & Connector

| Export | Description |
|--------|-------------|
| `GitHubCopilotAgent` | Agent class (middle layer) |
| `GitHubCopilotConnector` | Connector class (SDK bridge) |

### Session Management

| Export | Description |
|--------|-------------|
| `CopilotConnectorSession` | Session abstraction |
| `CopilotConnectorTurn` | Turn abstraction |
| `UserMessageQueue` | Internal connector queue from adapter core |

### Namespaces & Types

| Export | Description |
|--------|-------------|
| `GitHubCopilotConnectorNamespace` | Bus namespace for connector events |
| `GitHubCopilotConnectorSubjects` | Subject constants for bus messaging |
| `GitHubCopilotConnectorBus` | Bus type for connector |
| `CopilotSessionOptions` | Session options type |
| `ConsumptionCompleteResult` | Consumption result type |
| `GitHubCopilotAgentConnectorConfig` | Agent connector config type |

### Tool Handling

| Export | Description |
|--------|-------------|
| `registerToolApprovalHandler` | Register handler for tool approval requests |
| `requestToolApproval` | Request tool approval |
| `toGlobalToolApproval` | Convert to global approval format |
| `fromGlobalToolApproval` | Convert from global approval format |
| `mapPermissionRequestToCoreRequest` | Map Copilot permission to core request |
| `mapCoreResponseToPermissionResult` | Map core response to Copilot permission |

### Configuration & Schemas

| Export | Description |
|--------|-------------|
| `GitHubCopilotSdkProviderConfigSchema` | Zod schema for provider config |
| `GitHubCopilotSdkProviderSettings` | Provider settings type |
| `createTestConfig` | Conformance test configuration factory |

### Runtime Contribution

Runtime registration is contributed by `@makaio/adapter-github-copilot-sdk/server`.
That entrypoint default-exports the `githubCopilotSdkPackage` `MakaioExtension`
descriptor, whose `adapters[]` entry wraps the internal definition from
`src/definition.ts`.

### Event Normalizers

| Export | Description |
|--------|-------------|
| `normalizeGitHubCopilotLogRecord` | Main dispatcher for all event types |
| `normalizeAssistantTurnStart` | Normalize assistant.turn_start to agent.started |
| `normalizeAssistantMessage` | Normalize assistant.message to agent.message |
| `normalizeToolUserRequested` | Normalize tool.user_requested to agent.tool.use |
| `normalizeToolExecutionStart` | Normalize tool.execution_start |
| `normalizeToolExecutionPartialResult` | Normalize tool.execution_partial_result |
| `normalizeToolExecutionComplete` | Normalize tool.execution_complete |
| `normalizeSessionTruncation` | Normalize session.truncation to agent.usage |
| `normalizeSessionError` | Normalize session.error to agent.error |
| `normalizeUserMessage` | Normalize user.message (import-only) |
| `normalizeAssistantTurnEnd` | Normalize assistant.turn_end (import-only) |
| `NormalizationContext` | Context for normalization |
| `RawGitHubCopilotLogRecord` | Raw log record structure |
| `NormalizeOptions` | Options for normalization |

## Environment

Runtime sessions require GitHub Copilot credentials. `COPILOT_TOKEN` is a
runtime credential environment variable when credentials are provided through the
environment. The canonical GitHub Copilot provider maps the stored `token`
credential field to `COPILOT_TOKEN`; the connector also accepts a resolved
`token` credential directly and passes it to the SDK as `githubToken`.

Model registry generation uses the Copilot SDK authentication flow (for example
an authenticated GitHub CLI session or supported SDK token source), not provider
config.

## File Structure

```
src/
├── index.ts              # Package exports
├── adapter.ts            # GitHubCopilotAdapter class
├── agent.ts              # GitHubCopilotAgent class
├── connector.ts          # GitHubCopilotConnector class
├── session.ts            # Session management
├── turn.ts               # Turn management
├── config.ts             # Configuration utilities
├── constants.ts          # Adapter constants
├── definition.ts         # Internal adapter definition
├── package.ts            # MakaioExtension package descriptor
├── provider.ts           # Provider registration
├── provider.fetcher.ts   # Registry model fetcher using Copilot SDK auth
├── server.ts             # Server entrypoint exporting the package descriptor
├── schemas.ts            # Zod schemas
├── tool-handling.ts      # Tool approval utilities
├── event-normalizers.ts  # Event normalization
├── namespaces/           # Bus namespace definitions
│   └── schemas/          # Message schemas
├── types/                # TypeScript types
└── utils/                # Utility functions
    ├── formatMessageHistoryAsTranscript.ts
    └── normalizedMessageToPrompt.ts
```

---

*Part of the Makaio AI framework*

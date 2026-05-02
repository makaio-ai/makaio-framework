# @makaio/adapter-gemini-sdk

Google Gemini SDK adapter for the Makaio AI framework.

## Quick Start

```typescript
import { createGeminiSDKAdapter, GeminiAdapter } from '@makaio/adapter-gemini-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

// Using the factory function (recommended)
const adapter = await createGeminiSDKAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
});

// Or using the class directly
const directAdapter = new GeminiAdapter();
await directAdapter.init();
```

## Architecture

This adapter follows the three-layer architecture pattern:

```
GeminiAdapter extends AIAdapter
    -> creates via agentFactory()
GeminiAgent extends AIAgent
    -> receives connector via connectorFactory()
GeminiConnector extends AIAgentConnector
```

**Layers:**

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Adapter | `GeminiAdapter` | Factory for agents, handles `adapter.startAgent` RPC |
| Agent | `GeminiAgent` | Wires events to global bus, manages lifecycle |
| Connector | `GeminiConnector` | SDK-level bridge to Google Gemini |

**Session/Turn Management:**

| Class | Purpose |
|-------|---------|
| `GeminiConnectorSession` | Session lifecycle, prompt cache preservation |
| `GeminiConnectorTurn` | Individual turn handling |
| `UserMessageQueue` | Internal connector queue from adapter core |

## Capabilities

- `tools` - Tool/function calling support
- `streaming` - Streaming responses
- `systemPrompt:override` - Replace/set the system prompt
- `systemPrompt:append` - Append to the adapter's default system prompt
- Tool approval workflow via `registerToolApprovalHandler`
- Replace and interrupt delivery modes

## Exports

### Adapter

| Export | Description |
|--------|-------------|
| `GeminiAdapter` | Main adapter class |
| `createGeminiSDKAdapter` | Factory function (creates and initializes) |
| `GeminiSdkAdapterName` | Adapter identifier constant |

### Agent & Connector

| Export | Description |
|--------|-------------|
| `GeminiAgent` | Agent class (middle layer) |
| `GeminiConnector` | Connector class (SDK bridge) |
| `GeminiAgentLegacy` | Legacy alias for GeminiConnector |

### Session Management

| Export | Description |
|--------|-------------|
| `GeminiConnectorSession` | Session abstraction |
| `GeminiConnectorTurn` | Turn abstraction |
| `UserMessageQueue` | Internal connector queue from adapter core |

### Namespaces & Types

| Export | Description |
|--------|-------------|
| `GeminiConnectorNamespace` | Bus namespace for connector events |
| `GeminiConnectorSubjects` | Subject constants for bus messaging |
| `GeminiAgentMetadata` | Agent metadata type |
| `GeminiConnectorConfig` | Connector configuration type |
| `GeminiAgentConnectorConfig` | Agent connector config type |
| `GeminiSessionConfig` | Session configuration type |

### Tool Handling

| Export | Description |
|--------|-------------|
| `registerToolApprovalHandler` | Register handler for tool approval requests |
| `requestToolApproval` | Request tool approval |
| `toGlobalToolApproval` | Convert to global approval format |
| `fromGlobalToolApproval` | Convert from global approval format |

### Configuration & Schemas

| Export | Description |
|--------|-------------|
| `GeminiSdkProviderConfigSchema` | Zod schema for provider config |

## Prerequisites and Authentication

Install the peer SDK packages provided by the framework workspace or your package manager. Runtime
sessions require Google Gemini credentials. The adapter supports:

- API-key auth via the canonical Google provider credential, mapped to `GEMINI_API_KEY`.
- OAuth auth via the `google-oauth` provider path used by the Gemini CLI core.

If an API-key credential ref is configured, the adapter uses API-key auth and fails fast when the
resolved key is empty. OAuth fallback is used only when no API-key credential is supplied.

## File Structure

```
src/
├── index.ts              # Package exports
├── adapter.ts            # GeminiAdapter class
├── agent.ts              # GeminiAgent class
├── connector.ts          # GeminiConnector class
├── session.ts            # Session management
├── turn.ts               # Turn management
├── config.ts             # Configuration utilities
├── constants.ts          # Adapter constants
├── definition.ts         # Internal adapter definition
├── models.ts             # Model catalog
├── package.ts            # MakaioExtension package descriptor
├── provider.ts           # Provider registration
├── provider.fetcher.ts   # Model fetcher
├── rate-limiter.ts       # Rate limiting
├── server.ts             # Server entrypoint exporting the package descriptor
├── schemas.ts            # Zod schemas
├── tool-handling.ts      # Tool approval utilities
├── namespaces/           # Bus namespace definitions
├── types/                # TypeScript types
└── utils/                # Utility functions
```

---

*Part of the Makaio AI framework*

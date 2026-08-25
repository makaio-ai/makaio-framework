# @makaio/adapter-openai-node

OpenAI adapter implementation using the official OpenAI Node SDK for agentic chat completions.

## Quick Start

```typescript
import { OpenAIAdapter, createOpenAINodeAdapter } from '@makaio/adapter-openai-node';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

// Using the convenience factory
const adapter = await createOpenAINodeAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
  model: 'gpt-4.1',
});

// Or using the class directly
const directAdapter = new OpenAIAdapter({ machineId: 'runtime-machine', ownerInstanceId: 'runtime-owner' });
await directAdapter.init();

const directResult = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: directAdapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
  model: 'gpt-4.1',
});
```

## Architecture

This adapter implements a three-layer architecture for clean separation of concerns:

```
OpenAIAdapter (extends AIAdapter)
    ↓ creates via agentFactory()
OpenAIAgent (extends BaseStreamAgent)
    ↓ creates via connectorFactory()
OpenAINodeConnector (extends BaseStreamConnector)
    ↓ wraps
OpenAI SDK Client
```

### Layer Responsibilities

| Layer | Class | Responsibility |
|-------|-------|----------------|
| **Adapter** | `OpenAIAdapter` | Handle `adapter.startAgent` RPC, manage agent lifecycle, emit adapter events |
| **Agent** | `OpenAIAgent` | Wire connector events to global `agent.*` subjects, enrich payloads with agent context |
| **Connector** | `OpenAINodeConnector` | SDK client setup, credentials, tool loading, stream-session lifecycle |
| **Session** | `OpenAIConnectorSession` | OpenAI message history, streaming API calls, and the agentic tool-call loop |

### Agentic Loop Pattern

The session implements the standard agentic loop:

1. Send user message to OpenAI
2. Process streaming response
3. If `tool_calls` present, execute tools via Bus RPC and recurse
4. When no `tool_calls`, mark turn complete

## Key Concepts

`OpenAIAgent`, `OpenAINodeConnector`, `OpenAIConnectorSession`, `OpenAIConnectorTurn`, and
namespace exports are public for framework implementers and tests. Most applications should use
the `./server` runtime contribution or `createOpenAINodeAdapter()` rather than constructing the
lower layers directly.

### Semantic Event Subjects

Raw SDK events are normalized into typed semantic subjects:

| Subject | Description |
|---------|-------------|
| `chunk` | Streaming text delta |
| `usage` | Token usage metrics |
| `tool_calls` | Tool call requests from model |
| `tool_started` | Tool execution started |
| `tool_completed` | Tool execution finished |
| `message_complete` | Full message assembled |
| `reasoning_delta` | Reasoning content delta (o1-style) |
| `reasoning_complete` | Full reasoning assembled |
| `agent_started` | Agent turn started |
| `agent_complete` | Agent turn finished |
| `error` | Error occurred |

`sdk.event` carries an envelope with an `event` property. The exported `SdkEvent` type is the
envelope; use `SdkEventMessage` internally when you need the nested discriminated union.

### Session and Turn Management

- `OpenAIConnectorSession` - Manages turn lifecycle and message history
- `OpenAIConnectorTurn` - Handles a single turn's streaming and tool execution
- `UserMessageQueue` - Internal queue from adapter core

### Tool Approval Flow

Tool execution routes through the approval system:

1. Connector emits `tool_approval` RPC on scoped bus
2. Agent wires to global `AgentSubjects.toolApprove`
3. Approval handler responds with approve/deny
4. Connector proceeds or skips based on response

## Exports

### Classes

| Export | Description |
|--------|-------------|
| `OpenAIAdapter` | Domain-level adapter, handles `adapter.*` subjects |
| `OpenAIAgent` | Agent wrapper, handles `agent.*` subjects |
| `OpenAINodeConnector` | SDK connector, extends `BaseStreamConnector` |
| `OpenAIConnectorSession` | Session state management |
| `OpenAIConnectorTurn` | Single turn execution |
| `UserMessageQueue` | Internal queue from adapter core |

### Namespace and Subjects

| Export | Description |
|--------|-------------|
| `OpenAINodeConnectorNamespace` | Bus namespace with typed schemas |
| `OpenAINodeConnectorSubjects` | Pre-extracted subject constants |
| `OPENAI_NODE_NAMESPACE` | Namespace string constant |
| `SdkEvent` | `sdk.event` envelope with nested `event` discriminated union |

### Configuration

| Export | Description |
|--------|-------------|
| `OpenAISessionConfig` | Session configuration type |
| `createTestConfig` | Conformance test suite configuration |

Provider settings may set `requestCorrelationHeaders: "factory-v1"` when
`baseUrl` targets a trusted Factory Gateway. The adapter then projects only the
content-free `SessionContext.requestCorrelation` allowlist plus runtime-owned
session, message, and per-request LLM-call IDs to `x-factory-*` headers. The
option is disabled by default so these identifiers are never sent to arbitrary
OpenAI-compatible endpoints.

### Runtime Contribution

Runtime registration is contributed by `@makaio/adapter-openai-node/server`.
That entrypoint default-exports the `openaiNodePackage` `MakaioExtension`
descriptor, whose `adapters[]` entry wraps the internal definition from
`src/definition.ts`.

## Usage Telemetry

Each `agent.usage` event corresponds to exactly one OpenAI API call: token
counts are extracted from the streaming usage chunk of the request. The API
reports no monetary amount, so no `cost` is emitted. Every event carries a
runtime-generated `llmCallId` identifying the concrete provider request
(projected to `x-factory-llm-call-id` when request correlation headers are
enabled). See
[Usage & Provenance](../../../docs/architecture/adapters/usage-and-provenance.md).

## File Structure

```
src/
├── index.ts              # Public API exports
├── adapter.ts            # OpenAIAdapter class
├── agent.ts              # OpenAIAgent class
├── connector.ts          # OpenAINodeConnector class
├── session.ts            # Session management
├── turn.ts               # Turn execution
├── config.ts             # Configuration factory
├── constants.ts          # Namespace constants
├── definition.ts         # Internal adapter definition
├── package.ts            # MakaioExtension package descriptor
├── server.ts             # Server entrypoint exporting the package descriptor
├── provider.ts           # Provider registration
├── model-normalization.ts # Model metadata normalization
├── mcp-integration.ts    # MCP tool integration
├── tool-handling.ts      # Tool approval and execution
├── stream-bridge.ts      # SDK stream normalization
├── schemas.ts            # Non-secret provider config schema
├── namespaces/
│   ├── index.ts          # Namespace registration
│   └── schemas/          # Event type schemas
│       ├── chunk.ts
│       ├── message.ts
│       ├── reasoning.ts
│       ├── tool-calls.ts
│       └── usage.ts
├── types/
│   └── index.ts          # TypeScript type definitions
└── utils/
    ├── blockToContentPart.ts
    ├── buildChatCompletionRequest.ts
    ├── classifyOpenAIError.ts
    └── convertMessageHistory.ts
```

---

*Part of the Makaio AI framework*

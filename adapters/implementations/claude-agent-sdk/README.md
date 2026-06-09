# @makaio/adapter-claude-agent-sdk

Claude Agent SDK adapter using the three-layer architecture.

## Quick Start

```typescript
import { createClaudeAdapter, ClaudeCodeAdapter } from '@makaio/adapter-claude-agent-sdk';
import { AdapterSubjects } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

// Using the factory (recommended)
const adapter = await createClaudeAdapter();

// Or instantiate directly
const directAdapter = new ClaudeCodeAdapter();
await directAdapter.init();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Build a todo app',
  model: 'sonnet',
});
```

## Architecture

The adapter follows a three-layer architecture:

```
ClaudeCodeAdapter extends AIAdapter
    -> creates via agentFactory
ClaudeCodeAgent extends AIAgent
    -> creates via connectorFactory
ClaudeSdkConnector extends AIAgentConnector
```

### Layer Responsibilities

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Adapter | `ClaudeCodeAdapter` | Lifecycle, agent factory, model listing |
| Agent | `ClaudeCodeAgent` | Event wiring, tool approval routing, usage tracking |
| Connector | `ClaudeSdkConnector` | SDK query lifecycle, session management, message handling |

## Key Concepts

### Event Flow

1. `ClaudeSdkConnector` emits SDK events to scoped bus (`adapter:claude-code.*`)
2. `ClaudeCodeAgent` processes and routes to global bus (`agent.*`)
3. Downstream consumers subscribe to normalized `agent.*` subjects

### Namespace Subjects

The adapter registers `adapter:claude-code` namespace with typed subjects:

| Subject | Description |
|---------|-------------|
| `sdk.event` | Catch-all for raw SDK events |
| `system` | System messages (init, compact_boundary) |
| `assistant` | Assistant content blocks |
| `user` | User messages and tool results |
| `result` | Query completion (success/error) |
| `stream_event` | Streaming deltas |
| `turn.*` | Turn lifecycle events |
| `can_use_tool` | Tool approval RPC |

## Exports

### Classes

| Export | Description |
|--------|-------------|
| `ClaudeCodeAdapter` | Main adapter class |
| `ClaudeCodeAgent` | Agent layer for event routing |
| `ClaudeSdkConnector` | SDK connector layer |

### Functions

| Export | Description |
|--------|-------------|
| `createClaudeAdapter` | Factory that creates and initializes adapter |
| `createTestConfig` | Conformance test configuration |
| `registerToolApprovalHandler` | Set up tool approval routing |
| `requestToolApproval` | Request approval for a tool call |

### Namespace

| Export | Description |
|--------|-------------|
| `ClaudeCodeConnectorNamespace` | Full namespace definition |
| `ClaudeCodeConnectorSubjects` | Subject definitions for typed subscriptions |
| `ClaudeCodeAdapterName` | Adapter identifier constant |

### Types

| Export | Description |
|--------|-------------|
| `ClaudeCodeAdapterConfig` | Adapter configuration options |
| `ClaudeAgentConfig` | Agent configuration |
| `ClaudeCodeProviderConfig` | Provider-specific settings |
| `ClaudeCodeConnectorBus` | Typed scoped bus |
| `ClaudePermissionResult` | Tool approval permission result |
| `ToolApprovalContext` | Tool approval context type |

### Session/Turn

| Export | Description |
|--------|-------------|
| `ClaudeConnectorTurn` | Turn state machine |
| `ClaudeTurnState` | Turn state type |
| `UserMessageQueue` | Internal connector queue from adapter core |

### Schemas

| Export | Description |
|--------|-------------|
| `ClaudeCodeProviderConfigSchema` | Zod schema for provider config |
| `CONTENT_BLOCK_HANDLERS` | Discriminated handlers for content blocks |

### Adapter Definition

Runtime registration is contributed by `@makaio/adapter-claude-agent-sdk/server`.
That entrypoint default-exports the `claudeAgentSdkPackage` `MakaioExtension`
descriptor, whose `adapters[]` entry wraps the internal definition from
`src/definition.ts`.

## Supported Models

| Name | Friendly Name | Reasoning Levels |
|------|---------------|-----------------|
| `sonnet` | Sonnet 4.5 | none, low, medium, high, extra-high |
| `haiku` | Haiku 4.5 | none, low, medium, high, extra-high |
| `opus` | Opus 4.6 | none, low, medium, high, extra-high |

## Capabilities

- `tools` - Tool use support
- `vision` - Image/vision input
- `structuredOutput` - Native JSON schema output through the Agent SDK `outputFormat`
- `chat:inTurnMessages` - Multi-turn conversation
- `systemPrompt:override` - Replace/set the system prompt

## File Structure

```
src/
├── index.ts                       # Package exports
├── adapter.ts                     # ClaudeCodeAdapter
├── agent.ts                       # ClaudeCodeAgent
├── connector.ts                   # ClaudeSdkConnector
├── session.ts                     # Session abstraction
├── turn.ts                        # Turn state machine
├── config.ts                      # Configuration resolution
├── constants.ts                   # Adapter name constant
├── definition.ts                  # Internal adapter definition
├── package.ts                     # MakaioExtension package descriptor
├── provider.ts                    # Provider registration
├── provider.fetcher.ts            # Model fetcher
├── server.ts                      # Server entrypoint exporting the package descriptor
├── schemas.ts                     # Provider config schemas
├── mcp-integration.ts             # MCP tool integration
├── account-observation.ts         # Account observation
├── account-observation-requester.ts
├── namespace/
│   └── index.ts                   # Namespace + subjects
├── types/
│   └── index.ts                   # Internal types
├── utils/                         # Helper functions
└── __tests__/                     # Unit tests + fixtures
```

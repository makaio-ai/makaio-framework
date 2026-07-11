# @makaio/adapter-codex-app-server

OpenAI Codex App-Server adapter for the Makaio AI framework.

Communicates with `codex app-server` via stdio subprocess using JSON-RPC 2.0 over JSONL.

## Quick Start

```typescript
import {
  CodexAppServerAdapter,
  createCodexAppServerAdapter,
} from '@makaio/adapter-codex-app-server';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

// Using the factory function (recommended)
const adapter = await createCodexAppServerAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  cwd: process.cwd(),
  initialMessage: 'Inspect this repository',
  model: 'gpt-5.1-codex-mini',
});

// Or using the class directly
const directAdapter = new CodexAppServerAdapter();
await directAdapter.init();
```

## Architecture

This adapter follows the three-layer architecture pattern:

```
CodexAppServerAdapter extends AIAdapter
    -> creates via agentFactory()
CodexAppServerAgent extends AIAgent
    -> receives connector via connectorFactory()
CodexAppServerConnector extends AIAgentConnector
    -> JsonRpcClient
    -> StdioTransport
    -> [codex app-server subprocess]
```

**Layers:**

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Adapter | `CodexAppServerAdapter` | Factory for agents, handles `adapter.startAgent` RPC |
| Agent | `CodexAppServerAgent` | Wires events to global bus, manages lifecycle |
| Connector | `CodexAppServerConnector` | JSON-RPC bridge to codex app-server subprocess |

**Thread/Turn Management:**

| Class | Purpose |
|-------|---------|
| `CodexAppServerThread` | Thread lifecycle management |
| `CodexAppServerTurn` | Individual turn handling |
| `UserMessageQueue` | Internal connector queue from adapter core |

## Capabilities

- `tools` - Tool/function calling support (bash, patch)
- `streaming` - Streaming responses
- `systemPrompt:override` - Replace/set the system prompt
- `systemPrompt:append` - Append to the adapter's default system prompt
- Tool approval workflow via agent wiring to `AgentSubjects.toolApprove`
- File change approval workflow
- Replace and interrupt delivery modes
- Reasoning support with configurable effort levels

## Usage Telemetry

`agent.usage` is emitted per `thread/tokenUsage/updated` notification, using
the protocol's `tokenUsage.last` bucket — the token counts of the latest model
request covered by that update. The protocol reports no monetary amount and
does not expose a provider call ID, so `cost` and `llmCallId` are never set.
See
[Usage & Provenance](../../../docs/architecture/adapters/usage-and-provenance.md).

## Exports

### Adapter

| Export | Description |
|--------|-------------|
| `CodexAppServerAdapter` | Main adapter class |
| `createCodexAppServerAdapter` | Factory function (creates and initializes) |
| `CodexAppServerAdapterName` | Adapter identifier constant |

### Agent & Connector

| Export | Description |
|--------|-------------|
| `CodexAppServerAgent` | Agent class (middle layer) |
| `CodexAppServerConnector` | Connector class (JSON-RPC bridge) |

### Thread Management

| Export | Description |
|--------|-------------|
| `CodexAppServerThread` | Thread abstraction |
| `CodexAppServerTurn` | Turn abstraction |

### Namespaces & Types

| Export | Description |
|--------|-------------|
| `CodexAppServerNamespace` | Bus namespace for connector events |
| `CodexAppServerSubjects` | Subject constants for bus messaging |
| `CodexAppServerBus` | Typed bus type |

### Tool Handling

| Export | Description |
|--------|-------------|
| `registerToolApprovalHandler` | Register handler for tool approval requests |
| `toGlobalToolApproval` | Convert to global tool approval format |
| `toGlobalFileApproval` | Convert to global file approval format |
| `fromGlobalToolApproval` | Convert from global approval format |
| `ToolApprovalContext` | Tool approval context type |
| `CodexToolApprovalDecision` | Approval decision type |

### Configuration & Schemas

| Export | Description |
|--------|-------------|
| `CodexAppServerProviderConfigSchema` | Zod schema for provider config |
| `CodexAppServerProviderConfig` | Provider config type |
| `CodexAppServerConfig` | Config factory |

### Runtime Contribution

Runtime registration is contributed by `@makaio/adapter-codex-app-server/server`.
That entrypoint default-exports the `codexAppServerPackage` `MakaioExtension`
descriptor, whose `adapters[]` entry wraps the internal definition from
`src/definition.ts`.

### Utilities

| Export | Description |
|--------|-------------|
| `createStdioTransport` | Create stdio transport for subprocess |
| `createJsonRpcClient` | Create JSON-RPC client |

### Protocol Types

| Export | Description |
|--------|-------------|
| `ThreadStartedNotification` | Thread started event |
| `TurnStartedNotification` | Turn started event |
| `TurnCompletedNotification` | Turn completed event |
| `AgentMessageDeltaNotification` | Agent message delta event |
| `CommandExecutionOutputDeltaNotification` | Command output event |
| `ReasoningTextDeltaNotification` | Reasoning delta event |
| `FileChangeOutputDeltaNotification` | File change delta event |
| `ThreadTokenUsageUpdatedNotification` | Token usage event |

## Configuration Options

```typescript
interface CodexAppServerProviderConfig {
  /**
   * Reasoning effort level.
   * Maps to ReasoningEffort in app-server protocol.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';

  /**
   * Approval policy for tool execution.
   * Maps to AskForApproval in app-server protocol.
   */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';

  /**
   * Sandbox mode for command execution.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
}
```

`cwd`, `model`, and `env` are runtime/adapter options supplied on
`adapter.startAgent`, not provider config fields. Hosts should resolve the selected
provider/model before calling `startAgent` and pass that model explicitly. The current
adapter fallback is `gpt-5.1-codex-mini` for low-level tests and direct construction paths.

## Prerequisites

This adapter requires a Codex CLI build with `app-server` support.

### Installation

```bash
# Install Codex by the distribution method supported by your host.
# The adapter supports:
# - a host-managed absolute binary path
# - PATH lookup for `codex`
# - test/fetcher paths that spawn `codex app-server` directly

# Verify installation
codex --version
codex app-server --help
```

### Configuration

The adapter will spawn `codex app-server` as a subprocess via stdio. Ensure:
- The `codex` binary is host-resolved or available in PATH
- You have appropriate permissions for the working directory

## Protocol Methods

The adapter communicates with `codex app-server` using JSON-RPC 2.0 over JSONL:

The package exports generated protocol types from `src/protocol/generated/index.ts`. Prefer the
`v2` namespace for app-server protocol types when importing generated definitions.

### Client Requests

- `initialize` - Initialize connection handshake
- `thread/start` - Start new conversation thread (v2)
- `turn/start` - Send user message to agent (v2)
- `turn/interrupt` - Cancel current turn (v2)
- `model/list` - Fetch available Codex models

### Client Notifications

- `initialized` - Acknowledge successful initialization

### Server Notifications (Events)

- `thread/started` - Thread created
- `turn/started` - Agent begins processing turn
- `turn/completed` - Agent finished turn
- `item/started` - Item (message/tool/reasoning) started
- `item/completed` - Item completed
- `item/agentMessage/delta` - Streaming message content
- `item/commandExecution/outputDelta` - Streaming command output
- `item/reasoning/textDelta` - Streaming reasoning content
- `item/fileChange/outputDelta` - Streaming file change output
- `thread/tokenUsage/updated` - Token usage metrics

### Server Requests

- `item/commandExecution/requestApproval` - Request approval for command execution
- `item/fileChange/requestApproval` - Request approval for file changes

## Troubleshooting

### Subprocess fails to start

**Error:** `codex app-server exited with code 1`

**Solution:**
- Verify `codex` CLI is installed: `codex --version`
- Check the working directory is accessible
- Review stderr logs for subprocess errors

### JSONL parsing errors

**Error:** `Failed to parse JSONL`

**Solution:**
- This may indicate a protocol mismatch
- Ensure you're using the correct version of `codex`
- Check the subprocess logs for protocol errors

### Approval handling issues

**Error:** Tool approval timeout

**Solution:**
- Increase timeout in config
- Ensure the host has an `AgentSubjects.toolApprove` handler registered
- Check that the agent is initialized so its scoped approval wiring is active

### Connection issues

**Error:** `Failed to initialize connection`

**Solution:**
- Verify stdio transport is working
- Check that `codex app-server` is responding
- Ensure JSON-RPC handshake completes

## File Structure

```
src/
├── index.ts              # Package exports
├── adapter.ts            # CodexAppServerAdapter class
├── agent.ts              # CodexAppServerAgent class
├── connector.ts          # CodexAppServerConnector class
├── thread.ts             # Thread management
├── turn.ts               # Turn management
├── config.ts             # Configuration utilities
├── constants.ts          # Adapter constants
├── definition.ts         # Internal adapter definition
├── package.ts            # MakaioExtension package descriptor
├── server.ts             # Server entrypoint exporting the package descriptor
├── provider.ts           # Provider registration
├── schemas.ts            # Zod schemas
├── tool-handling.ts      # Tool approval utilities
├── dynamic-tool-handling.ts # Registry tool declaration and routing
├── event-normalizers.ts  # Event normalization
├── connector/            # JSON-RPC connection, lifecycle, and approval handlers
├── namespaces/           # Bus namespace definitions
│   ├── index.ts          # Namespace export
│   └── schemas/          # Message schemas
├── protocol/generated/   # Generated protocol types
│   ├── index.ts          # Protocol exports
│   └── v2/               # V2 protocol definitions
└── utils/                # Utility functions
    ├── createStdioTransport.ts
    └── jsonRpcClient.ts
```

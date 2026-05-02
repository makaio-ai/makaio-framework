# @makaio/adapter-claude-code-cli

Claude Code CLI AI adapter for the Makaio framework. Integrates with Claude by spawning
the `claude` CLI binary and consuming its JSONL stdout stream instead of using the Agent SDK.

## Quick Start

```typescript
import { createClaudeCliAdapter } from '@makaio/adapter-claude-code-cli';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';

const adapter = await createClaudeCliAdapter();

const result = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId: adapter.adapterId,
  role: 'lead',
  initialMessage: 'Inspect this repository',
  model: 'claude-sonnet',
});
```

## Architecture

Three-layer design matching the framework adapter contract:

| Layer | Class | Responsibility |
|-------|-------|----------------|
| Domain | `ClaudeCodeCliAdapter` | Handles `adapter.*` bus subjects, lifecycle |
| Agent | `ClaudeCodeCliAgent` | Handles `agent.*` subjects, routes connector events |
| Connector | `ClaudeCliConnector` | Spawns `claude -p`, reads JSONL stdout |

The CLI emits event shapes identical to the Anthropic SDK. Shared agent logic from
`@makaio/ai-adapters-claude-shared` handles all event routing without modification.

The connector namespace is `adapter:claude-code-cli`. It is scoped to connector and agent
events for this adapter; cross-namespace requests such as MCP session registration go through
the framework bus subjects owned by those services.

## Tool Approval via MCP

Tool approval requests flow through the singleton HTTP MCP bridge service rather than a
direct bus bridge. The bridge routes approval requests to `AgentSubjects.toolApprove` on
the global bus. Adapters register and unregister their per-session context through
`McpSubjects.session.register` and `McpSubjects.session.unregister`.

```typescript
import { McpSubjects } from '@makaio/contracts';

const { handled, data } = await MakaioBus.requestOptional(McpSubjects.session.register, {
  adapterSessionId: 'adapter-session-1',
  agentId: 'agent-1',
  adapterId: 'adapter-1',
  adapterName: 'claude-code-cli',
  sessionId: 'makaio-session-1',
  contextOverrides: {
    cwd: '/repo',
    sessionId: 'makaio-session-1',
    agentId: 'agent-1',
  },
});

if (handled) {
  console.log(data.port);
}
```

## Capabilities

The adapter declares runtime capabilities through the framework capability system and also exposes
test-specific metadata for the conformance suite.

Runtime capabilities declared by the adapter:

| Capability | Meaning |
|------------|---------|
| `tools` | Claude Code tool use through the CLI/MCP bridge |
| `chat:inTurnMessages` | Multiple user messages can be merged into the current turn |
| `systemPrompt:override` | Replace/set the system prompt |
| `systemPrompt:append` | Append to the adapter's default system prompt |

Conformance-test capabilities returned by `createTestConfig()`:

| Feature | Supported |
|---------|-----------|
| `supportsReplace` | No |
| `supportsInterrupt` | No |

## Model and Binary Resolution

`startAgent.model` should be supplied by the host after resolving the selected provider/model.
The CLI receives that value as `--model`; if omitted, the `claude` binary falls back to its own
configured default.

The adapter can use a host-resolved managed `claude` binary, an explicit
`providerConfig.binaryPath`, or PATH lookup for `claude`. An explicit provider config path wins.

## Conformance Testing

```typescript
import { createTestConfig } from '@makaio/adapter-claude-code-cli';

// Register bridge handlers when a test needs MCP approval routing
const config = await createTestConfig();
```

## File Index

| File | Purpose |
|------|---------|
| `src/adapter.ts` | `ClaudeCodeCliAdapter` and `createClaudeCliAdapter` factory |
| `src/agent.ts` | `ClaudeCodeCliAgent` — event routing layer |
| `src/connector.ts` | `ClaudeCliConnector` — spawns CLI process, reads JSONL |
| `src/session.ts` | `ClaudeCliSession` — session state for a single agent run |
| `src/turn.ts` | Turn state machine for one user/assistant exchange |
| `src/config.ts` | `ClaudeCodeCliConfig` — settings resolution |
| `src/provider.ts` | Provider presets and model configuration |
| `src/schemas.ts` | `ClaudeCodeCliProviderConfigSchema` |
| `src/types.ts` | Internal type definitions |
| `src/constants.ts` | Adapter name and shared constants |
| `src/definition.ts` | Internal adapter definition consumed by the package descriptor |
| `src/package.ts` | `MakaioExtension` package descriptor with `adapters[]` contribution |
| `src/server.ts` | Server entrypoint that re-exports the package descriptor as default |
| `src/namespace/` | Bus namespace, subjects, and event schemas |
| `src/utils/` | Utility functions (CLI args, stdio transport, etc.) |

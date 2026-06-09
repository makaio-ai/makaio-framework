---
title: Adapters
description: Connect AI providers to the Makaio Framework through the three-layer adapter contract.
---

Adapters bridge AI providers to the Makaio Framework. Each adapter wraps a provider SDK (or CLI,
or protocol) and exposes it as a bus-integrated agent that participates in sessions, executes
tools, and emits typed telemetry. Three layers exist because lifecycle ownership, turn
orchestration, and SDK translation change at different rates and for different reasons.

---

## The Three-Layer Contract

```text
AIAdapter           — lifecycle owner, bus integration, agent registry
    |
    +-- AIAgent     — turn execution, tool orchestration, event fan-out
          |
          +-- AIAgentConnector  — SDK bridge, streaming, protocol translation
```

| Layer | Base class | Owns |
|-------|------------|------|
| Adapter | `AIAdapter` | Adapter lifecycle, `adapter.*` subject handlers, agent creation and registry |
| Agent | `AIAgent` | Turn execution, `agent.*` subject handlers filtered by `agentId`, connector lifecycle |
| Connector | `AIAgentConnector` | Provider SDK calls, streaming, message normalization |

---

## Available Adapters

| Adapter | Package | Upstream SDK | Protocol | Capabilities |
|---------|---------|--------------|----------|--------------|
| `anthropic-sdk` | `@makaio/ai-adapters-anthropic-sdk` | `@anthropic-ai/sdk` | `anthropic` | `tools`, `streaming`, `systemPrompt:override`, `systemPrompt:append` |
| `claude-code` | `@makaio/ai-adapters-claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | `anthropic` | `tools`, `vision`, `structuredOutput`, `chat:inTurnMessages`, `systemPrompt:override` |
| `claude-code-cli` | `@makaio/ai-adapters-claude-code-cli` | Claude Code CLI (subprocess) | `anthropic` | `tools`, `chat:inTurnMessages`, `systemPrompt:override`, `systemPrompt:append` |
| `codex-app-server` | `@makaio/ai-adapters-codex-app-server` | Codex CLI (JSON-RPC over JSONL) | `openai` | `tools`, `streaming`, `systemPrompt:override`, `systemPrompt:append` |
| `gemini-sdk` | `@makaio/ai-adapters-gemini-sdk` | `@google/genai` | `openai` | `tools`, `streaming`, `systemPrompt:override`, `systemPrompt:append` |
| `github-copilot-sdk` | `@makaio/ai-adapters-github-copilot-sdk` | `@github/copilot-sdk` | `openai` | `tools`, `systemPrompt:override`, `systemPrompt:append` |
| `openai-node` | `@makaio/ai-adapters-openai-node` | `openai` | `openai` | `tools`, `streaming`, `systemPrompt:override`, `systemPrompt:append` |
| `pi-sdk` | `@makaio/ai-adapters-pi-sdk` | `@mariozechner/pi-coding-agent` | `anthropic` | `tools`, `streaming`, `systemPrompt:override`, `systemPrompt:append`, `modelSwitchInSession` |
| `qwen-acp` | `@makaio/ai-adapters-qwen-acp` | `@agentclientprotocol/sdk` (ACP) | `openai` | `tools`, `streaming`, `systemPrompt:override` |

`claude-code` is the adapter ID for the Agent SDK implementation in
`@makaio/ai-adapters-claude-agent-sdk`; `claude-code-cli` is the separate
subprocess CLI adapter.

The **Protocol** column is the wire protocol the adapter declares to the framework — how its
model outputs are structured and how tool calls are encoded. Adapters that use a non-standard
upstream transport (e.g., ACP for `qwen-acp`, JSON-RPC subprocess for `codex-app-server`)
still surface as an `openai` wire protocol so existing orchestration and tooling integration
requires no special-casing.

---

## Capabilities

Capabilities are string tokens declared in the adapter constructor. They tell callers what
the adapter supports at runtime without requiring a connection.

| Capability | Meaning |
|------------|---------|
| `tools` | Adapter supports tool/function calling |
| `vision` | Adapter accepts image inputs |
| `structuredOutput` | Adapter enforces JSON schema output (e.g., `response_format`) |
| `systemPrompt:override` | System prompt can be replaced per session |
| `systemPrompt:append` | System prompt can be appended to per session |
| `session:resume` | Agent can resume from stored session state |
| `session:fork` | Agent can fork an existing session |
| `chat:inTurnMessages` | Multiple user messages per turn are supported |
| `modelSwitchInSession` | Model can change mid-session without restarting |

Query capabilities from a connected adapter:

```ts
// RPC: adapter.getCapabilities → { capabilities: string[] }
const { capabilities } = await client.request(AdapterSubjects.getCapabilities, {
  adapterName: 'openai-node',
});
const caps = parseAIAdapterCapabilities(capabilities);
caps.tools;                         // true
caps.systemPromptOverride;          // true (colon-paths become camelCase)
caps.hasAll(['tools', 'vision']);   // boolean
```

Adapters can declare custom capabilities via TypeScript declaration merging. See
[Creating Adapters](../../creating-adapters) for the full declaration merging pattern.

---

## Lifecycle

`adapter.init()` registers all `adapter.*` subject handlers on the bus and fires
`adapter.initialized`. `adapter.close()` stops all running agents in reverse start order and
unregisters handlers.

Adapter instances are contributed through `MakaioExtension.adapters` and managed by the
adapter subsystem contribution processor, which calls `init()` and `close()` as part of the
extension lifecycle. See [Creating Adapters](../../creating-adapters) for the full implementation walkthrough.

---

## Bus Subjects

### `adapter.*`

These handlers are registered automatically by `AIAdapter`. Consumers send requests; the
adapter replies.

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `adapter.startAgent` | RPC | Create and start a new agent |
| `adapter.rehydrateAgent` | RPC | Resume an agent from stored session state |
| `adapter.stopAgent` | RPC | Stop a running agent |
| `adapter.listAgents` | RPC | List all active agents |
| `adapter.getAgent` | RPC | Get one active agent by `agentId` |
| `adapter.getCapabilities` | RPC | Query adapter capabilities |
| `adapter.infer` | RPC | One-shot inference without a session |
| `adapter.initialized` | Event | Adapter is ready to accept requests |
| `adapter.agent.created` | Event | New agent instance was created |
| `adapter.session.created` | Event | Agent opened a provider session |
| `adapter.session.closed` | Event | Provider session ended |
| `adapter.session.usage` | Event | Aggregated token usage for a session |
| `adapter.log` | Event | Adapter-level log message |
| `adapter.error` | Event | Adapter-level error |

### `agent.*`

These handlers are registered by `AIAgent` and filtered by `agentId`. The base class emits
them through typed helper methods; agents do not emit these subjects directly.

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `agent.sendMessage` | RPC | Send a user message to the agent |
| `agent.toolApprove` | RPC | Tool approval request routed to the approval service |
| `agent.getCapabilities` | RPC | Query agent-level capabilities |
| `agent.started` | Event | Agent began processing |
| `agent.complete` | Event | Agent finished (success or error) |
| `agent.idle` | Event | Agent is waiting for input |
| `agent.message_delta` | Event | Streaming text chunk |
| `agent.message` | Event | Assembled complete message |
| `agent.reasoning_delta` | Event | Streaming reasoning chunk |
| `agent.reasoning` | Event | Assembled complete reasoning block |
| `agent.tool.use` | Event | Tool invocation initiated |
| `agent.tool.started` | Event | Tool execution began |
| `agent.tool.output` | Event | Tool produced output |
| `agent.tool.completed` | Event | Tool execution finished |
| `agent.usage` | Event | Per-call token usage |
| `agent.turn.started` | Event | Turn began |
| `agent.turn.completed` | Event | Turn finished |
| `agent.step.started` | Event | Processing step began |
| `agent.step.finished` | Event | Processing step finished |
| `agent.contextWindow.updated` | Event | Context window fill level changed |
| `agent.model.changed` | Event | Model switched mid-session |
| `agent.cwd.changed` | Event | Working directory changed |
| `agent.session.closed` | Event | Agent session ended |

---

## Minimal Example

Send a message from the SDK and wait for the agent to complete the turn:

```ts
import { BusClient, SessionSubjects, AgentSubjects } from '@makaio/sdk';

const sessionId = crypto.randomUUID();
const client = new BusClient();
await client.connect();

// Start the turn — the framework routes via session to the appropriate adapter.
await client.request(SessionSubjects.sendMessage, {
  sessionId,
  agent: { kind: 'canonical-model', model: 'sonnet' },
  message: 'Hello!',
});

// Wait for the agent to signal turn completion.
const completion = await client.once(AgentSubjects.complete, {
  filter: { sessionId },
  timeoutMs: 120_000,
});

console.info(completion.payload);
client.close();
```

The session layer routes the `session.sendMessage` request to whichever adapter owns the
resolved model. Subscribe to `AgentSubjects.$all` filtered by `sessionId` to collect
streaming deltas, tool events, and usage.

---

## Deep Dives

| Topic | Document |
|-------|----------|
| Building a new adapter | [Creating Adapters](../../creating-adapters) |
| Models, providers, credentials | [Models & Providers](./models-and-providers) |
| How adapters are discovered and loaded | [Discovery](./discovery) |
| Publishing and versioning strategy | [Publishing](./publishing) |

<!-- web:hide -->

## Key Source Files

| File | Purpose |
|------|---------|
| `../../adapters/core/src/adapter/ai-adapter.ts` | `AIAdapter` base class |
| `../../adapters/core/src/adapter/types.ts` | `AIAdapterConfig`, `AIAdapterConstructorConfig` |
| `../../adapters/core/src/agent/ai-agent.ts` | `AIAgent` base class |
| `../../adapters/core/src/agent/agent-turn-executor.ts` | `AgentTurnExecutor` shared turn pipeline |
| `../../adapters/core/src/connector/agent-connector.ts` | `AIAgentConnector` abstract class |
| `../../adapters/core/src/types/capabilities.ts` | `AIAdapterCapabilityRegistry`, `parseAIAdapterCapabilities` |
| `../../adapters/shared/stream-session/src/connector/base-stream-connector.ts` | `BaseStreamConnector` |
| `../../adapters/shared/stream-session/src/agent/base-stream-agent.ts` | `BaseStreamAgent` |
| `../../packages/contracts/src/adapter/schemas.ts` | All `adapter.*` subject schemas |
| `../../packages/contracts/src/agent/schemas.ts` | All `agent.*` subject schemas |
| `../../sdks/typescript/src/index.ts` | `@makaio/sdk` — `BusClient`, subject re-exports |

<!-- /web:hide -->

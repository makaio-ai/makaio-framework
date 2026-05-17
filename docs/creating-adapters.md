---
title: Creating Adapters
description: Build AI provider adapters that connect language models to the Makaio Framework bus system.
---

Adapters are the framework's bridge to external AI providers. Each adapter wraps
a provider SDK (or CLI, or protocol) and exposes it as a bus-integrated agent
that participates in sessions, uses tools, and emits typed telemetry events.

This guide walks through the three-layer adapter contract, the bus subjects
adapters must implement, and how to build a new adapter from scratch. The OpenAI
adapter (`../adapters/implementations/openai-node/`) is the reference
implementation throughout.

For a high-level overview of adapters, available adapters, and capabilities, see
the [Adapter hub document](./architecture/adapters/index.md). For model and provider configuration,
see [Models & Providers](./architecture/adapters/models-and-providers). For how adapters are
discovered and loaded at boot, see [Discovery](./architecture/adapters/discovery).

## The Three-Layer Contract

Every adapter is composed of three classes, each with a distinct responsibility:

```text
AIAdapter           — lifecycle owner, bus integration, agent registry
    |
    +-- AIAgent     — turn execution, tool orchestration, event fan-out
          |
          +-- AIAgentConnector  — SDK bridge, streaming, protocol translation
```

| Layer | Base class | Owns |
|-------|-----------|------|
| Adapter | `AIAdapter` | Adapter lifecycle, `adapter.*` subject handlers, agent creation and registry |
| Agent | `AIAgent` | Turn execution, `agent.*` subject handlers (filtered by `agentId`), connector lifecycle |
| Connector | `AIAgentConnector` | Provider SDK calls, streaming, message normalization |

The split exists because these concerns change independently. Swapping from the
OpenAI SDK to a custom HTTP client only changes the connector. Adding a new tool
orchestration strategy only changes the agent. The adapter layer stays stable
across both.

## Layer 1: AIAdapter

`AIAdapter` is an abstract class that handles bus registration and agent
lifecycle. Your adapter subclass wires the three factories that tell the
framework how to create agents and connectors:

```ts
import { AIAdapter, type AIAdapterConfig } from '@makaio/ai-adapters-core';
import { MyNamespace } from './namespace.js';
import { MyAgent } from './agent.js';
import { MyConnector } from './connector.js';
import { MyConfig } from './config.js';

type MyBus = Awaited<ReturnType<typeof MyNamespace.scopedBus>>;

export class MyAdapter extends AIAdapter<MyBus, MyConnector, MyAgent> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: 'my-provider',
      capabilities: ['tools', 'systemPrompt:override'],
      namespace: MyNamespace,
      agentFactory: (agentConfig) => new MyAgent(agentConfig),
      configFactory: MyConfig.getConfig,
      connectorFactory: (config) => new MyConnector(config),
      ...config,
    });
  }
}
```

The constructor config (`AIAdapterConstructorConfig` in
`../adapters/core/src/adapter/types.ts`) requires:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | `string` | Unique adapter identifier (e.g., `'openai'`, `'anthropic-sdk'`) |
| `capabilities` | `string[]` | Declared capabilities (see [Capabilities](#capabilities)) |
| `namespace` | `BusNamespace` | The adapter's registered bus namespace |
| `agentFactory` | `(config) => AIAgent` | Creates agent instances |
| `configFactory` | `(input) => Promise<Config>` | Resolves runtime configuration (credentials, model, etc.) |
| `connectorFactory` | `(config) => AIAgentConnector` | Creates connector instances |

### Lifecycle

`AIAdapter` handles these automatically — you rarely need to override them:

- **`init()`** — Registers `adapter.startAgent`, `adapter.rehydrateAgent`,
  `adapter.stopAgent`, `adapter.listAgents`, `adapter.getAgent`,
  `adapter.getCapabilities`, and `adapter.infer` handlers on the bus. Calls
  `onInit()` if overridden.
- **`close()`** — Stops all running agents, unregisters bus handlers. Calls
  `onClose()` if overridden.

Override `onInit()` and `onClose()` for adapter-specific setup/teardown:

```ts
protected async onInit(): Promise<void> {
  // e.g., validate API key, warm caches
}

protected async onClose(): Promise<void> {
  // e.g., close persistent connections
}
```

## Layer 2: AIAgent

`AIAgent` is the middle layer. It creates a connector, registers per-agent bus
handlers (filtered by `agentId`), and orchestrates turn execution.

Every agent subclass must implement one abstract method:

```ts
protected abstract wireEvents(connector: TConnector): void | Promise<void>;
```

`wireEvents` is called during `init()` and after every connector swap. It
subscribes to connector-scoped bus events and fans them out to global `agent.*`
subjects. This is where provider-specific SDK events are translated into the
framework's normalized telemetry.

### What AIAgent Provides

The base class gives you these protected helpers for emitting standardized
events:

| Method | Emits |
|--------|-------|
| `emitStart(event?)` | `agent.started` |
| `emitCompletion(result)` | `agent.complete` |
| `emitError(result)` | `agent.complete` (with error) |
| `emitToolUse(toolName, args, nativeId)` | `agent.tool.use` |
| `emitToolOutput(output, hints)` | `agent.tool.output` |
| `emitStepStarted(stepType, blockData, content)` | `agent.step.started` |
| `emitStepFinished(stepType, content)` | `agent.step.finished` |
| `trackUsage(normalized)` | `agent.usage` |
| `emitContextWindowUpdate(input)` | `agent.contextWindow.updated` |
| `emitGlobal(subject, payload)` | Any subject, enriched with `AgentContext` |

You call these from `wireEvents` to translate connector events into the
framework's event model.

### AgentTurnExecutor

`AIAgent` delegates turn execution to `AgentTurnExecutor`
(`../adapters/core/src/agent/agent-turn-executor.ts`). The executor runs the
shared pipeline for every message:

1. Call `onBeforeDispatch()` (marks agent active in storage)
2. Run pre-user-message hooks (hooks can mutate message and session context)
3. Evaluate `shouldUseNativeResume()` (skip message history if the connector
   has native session state)
4. Call `connector.sendMessage()` or `connector.start()`
5. Fire post-user-message hooks (non-blocking)
6. Track the message handle for lifecycle events

You do not need to implement or override this — it runs automatically when the
bus dispatches `agent.sendMessage` to your agent.

## Layer 3: AIAgentConnector

`AIAgentConnector` is the SDK bridge. It owns the actual provider API calls
and translates provider-specific events into the connector's scoped bus.

### Abstract Methods to Implement

```ts
abstract initialize(options?): Promise<void>;
abstract start(message, options?): Promise<AgentStartResult>;
abstract sendMessage(message, options?): Promise<MessageHandle>;
abstract abort(): void;
abstract close(): Promise<void>;
abstract getAdapterSessionId(): Promise<string>;
abstract complete(): Promise<MessageResult | null>;
abstract interrupt(): Promise<void>;
```

### Optional Overrides

| Method | Default | When to Override |
|--------|---------|-----------------|
| `changeModelInPlace(newModel)` | Returns `false` | Provider supports in-session model switching |
| `changeCwdInPlace(newCwd)` | Returns `false` | Provider has working directory awareness |
| `changeReasoningInPlace(newLevel)` | Returns `false` | Provider supports reasoning level adjustment |
| `markToolRefreshPending()` | No-op | Provider needs explicit tool list refresh |

### Auto-Injected Metadata

The base class automatically injects `adapterName`, `agentId`, `adapterId`,
and `adapterSessionId` into every `emit()` and `requestToolApproval()` call.
Your connector implementation must not duplicate these fields — doing so
overwrites the framework-managed values.

### Mutation Contract

When implementing `changeModelInPlace`, return `true` if the provider accepted
the change but do not mutate `this.model` directly. The caller (`AIAgent`)
owns that update after a confirmed change.

## StreamSession: The Streaming Adapter Base

Most modern adapters use streaming APIs. The `stream-session` shared package
(`../adapters/shared/stream-session/`) provides base classes that implement
the full connector and agent protocols for streaming adapters:

### BaseStreamConnector

`BaseStreamConnector` (`stream-session/src/connector/base-stream-connector.ts`)
implements the full `AIAgentConnector` protocol. You extend it and provide
four hooks:

| Hook | Purpose |
|------|---------|
| `fetchTools()` | Resolve credentials, init SDK client, convert tools to provider format |
| `createSession()` | Build the streaming session object with all config |
| `getTurnSubjects()` | Return the namespace subjects for turn lifecycle events |
| `afterSessionCreated()` | Optional post-creation setup |

The base handles: lazy session initialization, user message queuing, MCP tool
injection, tool refresh flags, and canonical turn number tracking.

### BaseStreamAgent

`BaseStreamAgent` (`stream-session/src/agent/base-stream-agent.ts`) extends
`AIAgent` and implements `wireEvents()` using a two-tier fan-out:

1. **`wireSdkEvents()`** (abstract — you implement) — Routes the `sdk.event`
   catch-all from the connector to typed semantic subjects using
   `createConnectorEventMapping`.
2. **`wireSemanticEvents()`** (concrete) — Wires semantic subjects (`chunk`,
   `usage`, `toolCalls`, `messageComplete`, etc.) to global `agent.*` bus
   subjects.

Your agent subclass implements `wireSdkEvents()` and a few extraction methods:

```ts
type MySubjectSpec = StreamAdapterSubjectSpec<
  typeof MyConnectorSubjects.chunk.$meta.namespace
>;

class MyAgent extends BaseStreamAgent<MyBus, MyConnector, MySubjectSpec> {
  protected wireSdkEvents(): void {
    this.createConnectorEventMapping(
      MyConnectorSubjects.sdk.event,
      'eventType',
      {
        chunk: MyConnectorSubjects.chunk,
        usage: MyConnectorSubjects.usage,
        tool_calls: MyConnectorSubjects.tool_calls,
        message_complete: MyConnectorSubjects.message_complete,
        agent_started: MyConnectorSubjects.agent_started,
        agent_complete: MyConnectorSubjects.agent_complete,
        error: MyConnectorSubjects.error,
      },
      'event',
    );
  }

  protected getConnectorSubjects(): MySubjectSpec { ... }
  protected extractChunkText(payload: Record<string, unknown>): string { ... }
  protected extractUsagePayload(payload: Record<string, unknown>): NormalizedCallUsage { ... }
}
```

## Bus Subjects

### Adapter Subjects (`adapter.*`)

These are handled by `AIAdapter`. The base class registers handlers
automatically — you do not need to implement them:

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `adapter.startAgent` | RPC | Create and start a new agent |
| `adapter.rehydrateAgent` | RPC | Resume an agent from stored state |
| `adapter.stopAgent` | RPC | Stop a running agent |
| `adapter.listAgents` | RPC | List active agents |
| `adapter.getAgent` | RPC | Get one active agent by `agentId` |
| `adapter.getCapabilities` | RPC | Query adapter capabilities |
| `adapter.infer` | RPC | One-shot inference (no session) |
| `adapter.initialized` | Event | Adapter is ready |
| `adapter.agent.created` | Event | New agent instance created |
| `adapter.session.created` | Event | Agent started a provider session |
| `adapter.session.closed` | Event | Provider session ended |
| `adapter.session.usage` | Event | Aggregated token usage |
| `adapter.log` | Event | Adapter-level log message |
| `adapter.error` | Event | Adapter-level error |

`adapter.getConfigSchema` exists in the contracts package for settings/config UI, but
`AIAdapter` does not auto-register it. Config schema exposure is owned by the adapter
subsystem because schemas live on adapter definitions, not live adapter instances.

### Agent Subjects (`agent.*`)

These are handled by `AIAgent`, filtered by `agentId`. Your agent emits
these through the base class helpers:

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `agent.sendMessage` | RPC | Send a user message to the agent |
| `agent.toolApprove` | RPC | Request tool approval from the approval service |
| `agent.getCapabilities` | RPC | Query agent-level capabilities |
| `agent.started` | Event | Agent began processing |
| `agent.complete` | Event | Agent finished (success or error) |
| `agent.idle` | Event | Agent is waiting for input |
| `agent.message_delta` | Event | Streaming text chunk |
| `agent.message` | Event | Assembled complete message |
| `agent.reasoning_delta` | Event | Streaming reasoning chunk |
| `agent.reasoning` | Event | Assembled reasoning block |
| `agent.tool.use` | Event | Tool invocation started |
| `agent.tool.started` | Event | Tool execution began |
| `agent.tool.output` | Event | Tool produced output |
| `agent.tool.completed` | Event | Tool execution finished |
| `agent.usage` | Event | Per-call token usage |
| `agent.turn.started` | Event | Turn began |
| `agent.turn.completed` | Event | Turn finished |
| `agent.step.started` | Event | Processing step began |
| `agent.step.finished` | Event | Processing step finished |
| `agent.contextWindow.updated` | Event | Context window fill level changed |
| `agent.model.changed` | Event | Model was switched mid-session |
| `agent.cwd.changed` | Event | Working directory changed |
| `agent.session.closed` | Event | Agent session ended |

## Capabilities

Adapters declare their capabilities as string tokens in the constructor:

```ts
capabilities: ['tools', 'systemPrompt:override', 'session:resume']
```

The capability registry (`../adapters/core/src/types/capabilities.ts`) uses
TypeScript declaration merging. Declare capabilities at construction time and do not
mutate them dynamically unless the capability source itself is explicit and
source-backed. Built-in capabilities:

| Path | Meaning |
|------|---------|
| `tools` | Adapter supports tool/function calling |
| `vision` | Adapter accepts image inputs |
| `structuredOutput` | Adapter supports JSON schema output |
| `systemPrompt:override` | System prompt can be replaced per-session |
| `systemPrompt:append` | System prompt can be appended to |
| `session:resume` | Agent can resume from stored session state |
| `session:fork` | Agent can fork an existing session |
| `chat:inTurnMessages` | Multiple messages per turn supported; parsed as `caps.chatInTurnMessages` |
| `modelSwitchInSession` | Model can change mid-session |

Query capabilities at runtime:

```ts
const caps = parseAIAdapterCapabilities(adapter.capabilities);
caps.tools;                  // true
caps.systemPromptOverride;   // true (colon-paths become camelCase)
caps.hasAll(['tools', 'vision']); // boolean
```

### Extending Capabilities

Add provider-specific capabilities via declaration merging:

```ts
declare module '@makaio/ai-adapters-core' {
  interface AIAdapterCapabilityRegistry {
    artifacts: { beta: boolean };
  }
}

// Then declare:
capabilities: ['artifacts:beta']
// Query: caps.artifactsBeta
```

## Walkthrough: OpenAI Adapter

The OpenAI adapter at `../adapters/implementations/openai-node/` is the reference
implementation for streaming SDK adapters.

### `adapter.ts` — OpenAIAdapter

```ts
export class OpenAIAdapter extends AIAdapter<
  OpenAINodeConnectorBus,
  OpenAINodeConnector,
  OpenAIAgent
> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: OpenAINodeAdapterName,
      capabilities: ['tools', 'streaming', 'systemPrompt:override', 'systemPrompt:append'],
      agentFactory: (config) => new OpenAIAgent(config),
      configFactory: OpenAINodeConfig.getConfig,
      connectorFactory: (config) => new OpenAINodeConnector(config),
      namespace: OpenAINs,
      ...config,
    });
  }
}
```

No `onInit` or `onClose` overrides — the adapter is pure infrastructure wiring.

### `agent.ts` — OpenAIAgent

Extends `BaseStreamAgent`. Implements:

- `wireSdkEvents()` — Routes `sdk.event` envelopes by `eventType` discriminant
  to typed semantic subjects using `createConnectorEventMapping`
- `getConnectorSubjects()` — Maps namespace subjects to `StreamAdapterSubjectSpec`
- `extractChunkText(payload)` — Reads `choices[0].delta.content`
- `extractUsagePayload(payload)` — Maps `prompt_tokens`/`completion_tokens` to
  `NormalizedCallUsage`
- `wireToolApprovalRpc(connector)` — Routes the connector's `tool_approval` RPC
  to the global `AgentSubjects.toolApprove`

### `connector.ts` — OpenAINodeConnector

Extends `BaseStreamConnector`. Implements:

- `fetchTools()` — Resolves credentials, initializes `new OpenAI(...)`, converts
  framework tools to OpenAI's function format
- `createSession()` — Constructs `OpenAIConnectorSession` with system prompt,
  tools, and streaming config
- `getTurnSubjects()` — Returns the connector's turn namespace subjects

The `OpenAIConnectorSession` manages the streaming agentic loop. Each turn
calls `openai.chat.completions.create({ stream: true })` and emits SDK events
back to the connector's scoped bus.

## Conformance Tests

The framework ships a shared conformance test suite that validates the full
orchestration pipeline for any adapter:

```bash
MAKAIO_TEST_ADAPTER=openai-node yarn test adapters/implementations/__tests__
```

Tests live at `../adapters/implementations/__tests__/` and cover:

- `agents.simple.test.ts` — Initialization, processing state, basic round-trip
- `agents.queue.test.ts` — Message queue ordering (enqueue, replace, immediate)
- `agents.tool-approval.test.ts` — Tool approval RPC flow
- `orchestration/subjects.test.ts` — Subject emission coverage
- `orchestration/sendMessage.test.ts` — Full send-message pipeline
- `orchestration/continuation.test.ts` — Multi-turn continuation
- `orchestration/lifecycle-mutations.test.ts` — Model/CWD changes mid-session

### Making Your Adapter Conformance-Testable

Export a `createTestConfig()` function from your adapter's `src/index.ts`:

```ts
import {
  createTestProviderContext,
  resolveTestConfig,
  type ConformanceTestConfig,
} from '@makaio/ai-adapters-core';
import { registerToolApprovalHandler } from './tool-handling.js';
import { providerDefinitions } from './provider.js';

export async function createTestConfig(): Promise<
  ConformanceTestConfig<MyBus, MyConnector, MyAgent>
> {
  const bus = await MyNamespace.scopedBus();
  const testProviderDef = providerDefinitions[0];

  return {
    createConnector: async (options?) => {
      // Create a connector instance for testing
      const config = await MyConfig.getConfig({
        ...resolveTestConfig(options, bus, testProviderDef),
        sessionId: options?.sessionId ?? 'test-session-id',
      });
      return new MyConnector(config);
    },
    registerToolApprovalHandler,
    bus,
    capabilities: {
      supportsReplace: true,
      supportsInterrupt: true,
      supportsUsageMetrics: true,
    },
    options: {
      primaryModel: { definitionId: 'my-provider', modelName: 'my-fast-model' },
      secondaryModel: { definitionId: 'my-provider', modelName: 'my-default-model' },
    },
    // For orchestration tests:
    createAdapter: async (options) => {
      const adapter = new MyAdapter({ adapterId: options?.adapterId });
      await adapter.init();
      return adapter;
    },
    adapterName: 'my-provider',
    testProviderContext: createTestProviderContext(testProviderDef),
  };
}
```

When wiring tool approval manually, pass a complete `ToolApprovalContext`:
`adapterId`, `adapterName`, `agentId`, `adapterSessionId`, and `sessionId` are all
required for routing the global `AgentSubjects.toolApprove` request correctly.

The shared test harness (`__tests__/shared.ts`) dynamically imports your
adapter by name and calls `createTestConfig()`.

## Scaffolding a New Adapter

### 1. Create the Package

```text
adapters/implementations/my-provider/
  ├── descriptor.json     # Descriptor discovery contract
  ├── package.json
  ├── tsdown.config.ts
  ├── tsconfig.json
  └── src/
      ├── index.ts          # Adapter export + createTestConfig
      ├── server.ts         # Default export for descriptor entrypoints.server
      ├── package.ts        # MakaioExtension with adapters[] contribution
      ├── definition.ts     # Runtime adapter definition
      ├── namespace.ts       # Provider-specific bus namespace
      ├── config.ts          # Configuration factory
      ├── adapter.ts         # AIAdapter subclass
      ├── agent.ts           # AIAgent subclass (or BaseStreamAgent)
      └── connector.ts       # AIAgentConnector subclass (or BaseStreamConnector)
```

### 2. Register a Bus Namespace

```ts
// src/namespace.ts
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';

const MyProviderSchemas = {
  // Provider-specific events (optional)
  'sdk.event': z.object({ eventType: z.string(), data: z.unknown() }),
};

export const MyProviderNamespace = MakaioBus.registerNamespace(
  'adapter:myProvider',
  MyProviderSchemas,
);
```

### 3. Implement the Three Layers

For streaming providers, extend `BaseStreamConnector` and `BaseStreamAgent`
from `@makaio/ai-adapters-stream-session`. For non-streaming providers (e.g.,
CLI-backed), extend `AIAgentConnector` and `AIAgent` directly.

### 4. Register the Adapter with an Extension

Adapters are contributed via `MakaioExtension.adapters`. Create a `package.ts`
that wraps your adapter definition into an extension manifest:

```ts
// src/package.ts
import type { MakaioExtension } from '@makaio/contracts/extension';
import { adapterDefinition } from './definition.js';

const extension: MakaioExtension = {
  name: 'my-provider',
  displayName: 'My Provider',
  adapters: [{
    manifest: { name: 'my-provider', protocols: ['openai'] },
    definition: adapterDefinition,
  }],
};

export default extension;
```

Expose that package through `src/server.ts` and declare `"entrypoints": { "server": true }`
in `descriptor.json`. The runtime discovers adapters through descriptor-based extension
discovery and the adapter subsystem contribution processor. There is no separate adapter
discovery pipeline — adapters are extension contribution surfaces like tools or UI.
Use plural `manifest.protocols` on `AdapterManifest`; keep singular
`definition.protocol` on the runtime adapter definition when the adapter has one
active protocol.

### 5. Run Conformance Tests

```bash
MAKAIO_TEST_ADAPTER=my-provider yarn test adapters/implementations/__tests__
```

If your adapter passes the conformance suite, it works with the full
orchestration pipeline: bus request > adapter > agent > tool calls > events >
response.

<!-- web:hide -->

## Key Source Files

| File | Purpose |
|------|---------|
| `../adapters/core/src/adapter/ai-adapter.ts` | `AIAdapter` base class |
| `../adapters/core/src/adapter/types.ts` | `AIAdapterConfig`, `AIAdapterConstructorConfig` |
| `../adapters/core/src/agent/ai-agent.ts` | `AIAgent` base class |
| `../adapters/core/src/agent/agent-turn-executor.ts` | `AgentTurnExecutor` shared pipeline |
| `../adapters/core/src/connector/agent-connector.ts` | `AIAgentConnector` abstract class |
| `../adapters/core/src/types/capabilities.ts` | `AIAdapterCapabilityRegistry` |
| `../adapters/core/src/types/conformance-test-config.ts` | `ConformanceTestConfig` |
| `../adapters/shared/stream-session/src/connector/base-stream-connector.ts` | `BaseStreamConnector` |
| `../adapters/shared/stream-session/src/agent/base-stream-agent.ts` | `BaseStreamAgent` |
| `../adapters/implementations/openai-node/src/adapter.ts` | Reference adapter |
| `../adapters/implementations/openai-node/src/agent.ts` | Reference agent |
| `../adapters/implementations/openai-node/src/connector.ts` | Reference connector |
| `../adapters/implementations/__tests__/shared.ts` | Conformance test harness |
| `../packages/contracts/src/adapter/schemas.ts` | All `adapter.*` subject schemas |
| `../packages/contracts/src/agent/schemas.ts` | All `agent.*` subject schemas |

<!-- /web:hide -->

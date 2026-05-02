# @makaio/ai-adapters-core

Base classes, factory utilities, and shared infrastructure for Makaio AI adapter
implementations. Each AI provider (Claude, Gemini, OpenAI, …) extends the
abstractions here rather than re-implementing bus wiring, session lifecycle,
tool approval, and agent tracking from scratch.

## Installation

```
npm install @makaio/ai-adapters-core
```

## Usage

### Implement an adapter

```typescript
import {
  AIAdapter,
  createAdapterNamespace,
  type AIAdapterConfig,
} from '@makaio/ai-adapters-core';
import { z } from 'zod';

// Assume these are implemented/imported in your adapter package:
// - class MyLLMConfig
// - class MyLLMConnector
// - class MyLLMAgent

// 1. Create a typed namespace for adapter-specific subjects
const MyNamespace = createAdapterNamespace('adapter:my-llm', {
  tokenUsage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
  }),
});

type MyLLMBus = Awaited<ReturnType<typeof MyNamespace.scopedBus>>;

// 2. Extend AIAdapter — bus wiring, agent tracking, and session lifecycle included
class MyLLMAdapter extends AIAdapter<MyLLMBus, MyLLMConnector, MyLLMAgent> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: 'my-llm',
      capabilities: ['tools', 'streaming', 'systemPrompt:override'],
      namespace: MyNamespace,
      agentFactory: (agentConfig) => new MyLLMAgent(agentConfig),
      configFactory: MyLLMConfig.getConfig,
      connectorFactory: (fullConfig) => new MyLLMConnector(fullConfig),
      ...config,
    });
  }
}
```

### Use discriminated handlers for streaming responses

```typescript
import {
  defineDiscriminatedHandlers,
  processDiscriminatedItems,
} from '@makaio/ai-adapters-core';

const handlers = defineDiscriminatedHandlers<SdkChunk, 'type'>('type', {
  text_delta: (item, emit) => emit(MySubjects.textDelta, { delta: item.delta }),
  tool_use: (item, emit) => emit(MySubjects.toolUse, { id: item.id, input: item.input }),
  end_turn: (_item, emit) => emit(MySubjects.turnDone, {}),
});

await processDiscriminatedItems(sdkStreamChunks, handlers, emit);
```

## API overview

| Export | Description |
|--------|-------------|
| `AIAdapter` | Abstract base class; handles `adapter.*` bus subjects, owns agent registry |
| `createAdapterNamespace()` | Register a typed bus namespace for an adapter |
| `AIAgent` | Abstract base class for per-session agent instances |
| `AIAgentConnector` | Abstract bridge between `AIAgent` and the AI SDK |
| `BaseConnectorSession` | Optional base for connector-owned provider session state |
| `defineDiscriminatedHandlers()` | Build a type-safe map of async streaming item handlers |
| `defineDiscriminatedHandlersSync()` | Synchronous variant of `defineDiscriminatedHandlers` |
| `processDiscriminatedItems()` | Drive a stream through a discriminated handler map |
| `createToolApprovalHandler()` | Wire the standard tool-approval pipeline |
| `serializeTurnContext()` | Serialize session context blocks for prompt injection |
| `normalizeMessageInput()` | Normalize diverse message input shapes to canonical form |
| `resolvePresetCredentials()` | Resolve provider credentials from config presets |
| `cleanEnvForAdapter()` | Strip unsafe env vars before spawning adapter subprocesses |
| `normalizeMimeType()` / `isTextLikeMimeType()` | MIME type helpers for attachment handling |
| `type AIAdapterConfig` | Adapter configuration shape |
| `type AdapterNamespace` | Typed namespace returned by `createAdapterNamespace()` |
| `type AIAdapterContext` | Adapter factory context for descriptor-driven creation surfaces |

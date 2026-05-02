# Message Handling

Makaio adapters do not expose a direct `adapter.sendMessage()` API. Message traffic moves
through bus subjects owned by the adapter and agent layers:

- `AdapterSubjects.startAgent` creates an agent and optionally sends the first message.
- `AgentSubjects.sendMessage` sends a follow-up message to an existing agent.
- `AdapterSubjects.infer` runs one-shot inference without registering a long-lived agent.

## Starting An Agent

Use `AdapterSubjects.startAgent` when the caller needs an agent lifecycle, session identity,
tool orchestration, streaming events, or future follow-up turns.

```typescript
import { AdapterSubjects } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

const started = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId,
  role: 'lead',
  initialMessage: 'Summarize the current project state.',
  model: 'provider-model-id',
  cwd: '/workspace/project',
  systemPrompt: {
    mode: 'append',
    content: 'Keep the response concise.',
  },
});

if (!started.success) {
  throw new Error(started.message);
}

const { agentId, sessionId, messageId } = started;
```

`startAgent` returns identifiers, not final assistant text. Consumers observe normalized
`agent.*` events such as `agent.message_delta`, `agent.message`, `agent.complete`,
`agent.tool.use`, and `agent.usage`.

## Continuing An Agent

Use `AgentSubjects.sendMessage` for follow-up turns. Include the `sessionId` returned by
`startAgent` so hooks, storage, and session-aware services can resolve context.

```typescript
import { AgentSubjects } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

const response = await MakaioBus.request(AgentSubjects.sendMessage, {
  adapterId,
  agentId,
  sessionId,
  message: 'Now list the risky areas.',
  messageId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  deliveryMode: 'enqueue',
});

console.log(response.messageId);
```

The request acknowledges that the message entered the agent pipeline. Final content and errors
arrive on lifecycle events emitted by the agent.

## One-Shot Inference

Use `AdapterSubjects.infer` for short, stateless calls that should not create an agent record or
participate in multi-turn orchestration.

```typescript
import { AdapterSubjects } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

const result = await MakaioBus.request(AdapterSubjects.infer, {
  adapterId,
  prompt: 'Return a JSON title for this note.',
  model: 'provider-model-id',
  systemPrompt: 'Return only JSON.',
});

console.log(result.text);
```

## Message Shape

`initialMessage` and `AgentSubjects.sendMessage.message` accept either a plain string or a
structured message:

```typescript
{
  role: 'user',
  blocks: [
    { type: 'text', content: 'Review this screenshot.' },
    {
      type: 'image',
      source: {
        type: 'base64',
        data: encodedImage,
        mimeType: 'image/png',
      },
    },
  ],
}
```

Adapters normalize this input before it reaches the connector.

## Runtime Options

Common runtime options are carried on `startAgent`, `AgentSubjects.sendMessage`, or
`AdapterSubjects.infer` depending on the subject schema:

| Option | Applies to | Purpose |
|--------|------------|---------|
| `model` | `startAgent`, `infer` | Provider model identifier |
| `reasoningEffort` | `startAgent` | Reasoning level for providers that support it |
| `cwd` | `startAgent` | Working directory for tool-aware adapters |
| `allowedTools` / `disallowedTools` | `startAgent` | Adapter-specific tool policy |
| `systemPrompt` | `startAgent`, `infer` | Start accepts replace/append; infer accepts string instructions |
| `responseSchema` | `AgentSubjects.sendMessage` | JSON schema for structured output |
| `sessionContext` | `startAgent`, `AgentSubjects.sendMessage` | Curated history and resume/fork signals |
| `mcpSessionContext` | `startAgent` | Resolved MCP tools and servers |
| `providerContext` | `startAgent`, `infer` | Credential refs and provider definition identity |

`startAgent.role` is a session role, not a chat-message role. Valid values are `lead` and
`member`; user/assistant roles belong inside structured message blocks.

Check capabilities before setting optional features. For example, require
`structuredOutput` before sending `responseSchema`, `tools` before enabling tool use,
`streaming` before relying on incremental response events, and `modelSwitchInSession` before
changing models on an active agent.

## Error Handling

Bus requests throw if the subject has no handler or the handler rejects. Subject responses also
carry domain-level failures:

```typescript
const started = await MakaioBus.request(AdapterSubjects.startAgent, {
  adapterId,
  role: 'lead',
  initialMessage: 'Hello',
});

if (!started.success) {
  throw new Error(started.message);
}
```

For active turns, listen to `agent.complete`. A completed turn has `outcome: 'completed'`; other
outcomes include `error`, `cancelled`, `superseded`, `merged`, and `rejected`.

## See Also

- [Creating Adapters](../../../docs/creating-adapters.md) - Current adapter implementation guide
- [Capabilities](./capabilities.md) - Capability declaration and querying

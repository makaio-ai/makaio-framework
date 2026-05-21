# Capability System

Capabilities are declarative feature flags. Adapter classes declare them at construction time,
and host code checks them before enabling optional behavior.

## Declaring Capabilities

Current adapters declare capabilities in the `AIAdapter` constructor config:

```typescript
export class MyAdapter extends AIAdapter<MyBus, MyConnector, MyAgent> {
  public constructor(config?: Partial<AIAdapterConfig>) {
    super({
      name: 'my-provider',
      capabilities: [
        'tools',
        'streaming',
        'systemPrompt:override',
        'systemPrompt:append',
        'structuredOutput',
      ],
      namespace: MyNamespace,
      agentFactory: (agentConfig) => new MyAgent(agentConfig),
      configFactory: MyConfig.getConfig,
      connectorFactory: (fullConfig) => new MyConnector(fullConfig),
      ...config,
    });
  }
}
```

`AIAdapter` exposes this list through `AdapterSubjects.getCapabilities`. `AIAgent` exposes the
same capability list through `AgentSubjects.getCapabilities`, along with the active model.

Do not mutate capabilities after construction. If a provider has a real source-backed capability
change, model it explicitly at that source and keep the adapter declaration honest for the
features the adapter can actually route.

## Built-In Capabilities

The built-in registry lives in `../src/types/capabilities.ts`.

| Capability | Runtime property | Meaning |
|------------|------------------|---------|
| `systemPrompt` | `caps.systemPrompt` | Adapter accepts system-level instructions |
| `systemPrompt:override` | `caps.systemPromptOverride` | System prompt can be replaced |
| `systemPrompt:append` | `caps.systemPromptAppend` | System prompt can be appended to |
| `session:resume` | `caps.sessionResume` | Adapter can resume stored session state |
| `session:fork` | `caps.sessionFork` | Adapter can fork a session |
| `chat:inTurnMessages` | `caps.chatInTurnMessages` | Multiple user messages in one turn |
| `modelSwitchInSession` | `caps.modelSwitchInSession` | Active agent can change models mid-session |
| `streaming` | `caps.streaming` | Adapter emits incremental response events |
| `tools` | `caps.tools` | Adapter supports tool/function calling |
| `vision` | `caps.vision` | Adapter accepts image inputs |
| `structuredOutput` | `caps.structuredOutput` | Adapter supports model-level JSON schema enforcement |

`parseAIAdapterCapabilities()` derives runtime property names from the exact strings declared by
the adapter. `chat:inTurnMessages` is the canonical token used by current adapters; do not
check `hasAll(['chat:inTurnMessages'])` unless the adapter declares the colon-delimited spelling.

## Querying Capabilities

Adapter and agent capability RPCs return string tokens. Use `parseAIAdapterCapabilities()` when
callers want camel-cased boolean helpers or batch checks:

```typescript
import { AdapterSubjects } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import { parseAIAdapterCapabilities } from '@makaio/ai-adapters-core';

const { capabilities } = await MakaioBus.request(AdapterSubjects.getCapabilities, {
  adapterId,
});

const caps = parseAIAdapterCapabilities(capabilities);

if (caps.tools && caps.structuredOutput) {
  // Enable tool and responseSchema controls.
}

if (caps.hasAll(['tools', 'streaming', 'systemPrompt:override'])) {
  // Enable a workflow that requires both features.
}
```

## Extending Capabilities

Packages can add provider-specific capability tokens through declaration merging:

```typescript
declare module '@makaio/ai-adapters-core' {
  interface AIAdapterCapabilityRegistry {
    artifacts: {
      beta: boolean;
    };
  }
}

const caps = parseAIAdapterCapabilities(['artifacts:beta']);
caps.artifactsBeta;
```

Only add custom capabilities when host or application code checks them before invoking behavior.

## Best Practices

Declare only features the adapter implements end to end. Platform code trusts capability
declarations and may skip fallbacks once a feature is advertised.

Prefer precise capability variants over vague tokens. For example, use
`systemPrompt:override` and `systemPrompt:append` to describe which system-prompt operations
work.

Check capabilities before sending optional request fields:

```typescript
import { AgentSubjects } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import { parseAIAdapterCapabilities } from '@makaio/ai-adapters-core';

const caps = parseAIAdapterCapabilities(capabilities);

if (!caps.structuredOutput) {
  throw new Error('Adapter does not support structured output');
}

await MakaioBus.request(AgentSubjects.sendMessage, {
  adapterId,
  agentId,
  sessionId,
  message: 'Return JSON.',
  responseSchema,
});
```

## See Also

- [Creating Adapters](/guides/creating-adapters/) - Current adapter implementation guide
- [Message Handling](./message-handling.md) - Bus subjects for start, follow-up, and infer

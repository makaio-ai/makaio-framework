# Creating AI Adapters

This file is retained only as a legacy entry point. The current adapter authoring guide is:

- [framework/docs/creating-adapters.md](../../../docs/creating-adapters.md)

Do not use the old object-interface examples that returned an `AIAdapter` literal with
`sendMessage()` and `getCapabilities()` methods. Current adapters use the three-layer class
model:

```text
AIAdapter
  -> AIAgent
    -> AIAgentConnector
```

An `AIAdapter` subclass declares constructor-time factories:

- `agentFactory` creates the `AIAgent` subclass.
- `configFactory` resolves runtime connector configuration.
- `connectorFactory` creates the `AIAgentConnector` subclass.

Runtime calls are bus based:

- Use `AdapterSubjects.startAgent` to create/start an agent.
- Use `AgentSubjects.sendMessage` to continue an existing agent.
- Use `AdapterSubjects.infer` for one-shot inference without registering a long-lived agent.

Capabilities are construction-time declarations on the adapter class. Declare only capability
tokens implemented by the adapter, such as `tools`, `vision`, `structuredOutput`,
`systemPrompt:override`, `systemPrompt:append`, `session:resume`, `session:fork`,
`streaming`, `chat:inTurnMessages`, and `modelSwitchInSession`.

`chat:inTurnMessages` is the registry-shaped spelling emitted by current adapters. Only use that
spelling after the adapter itself declares it, because capability checks compare exact strings.

---
'@makaio/ai-adapters-core': patch
---

Decompose the AIAgent facade: config-factory input assembly moves to `agent-config-input.ts` (with the shared `AgentConnectorConfigOverrides` type replacing four duplicated inline override shapes), the structured-output retry transform moves to `agent-structured-output-retry.ts`, the lifecycle-emitter factory joins `agent-internal-factories.ts`, and runtime-mutation bus handlers delegate inline. No behavior change.

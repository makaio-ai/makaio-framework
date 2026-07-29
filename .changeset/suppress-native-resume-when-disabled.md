---
"@makaio/ai-adapters-core": minor
"@makaio/adapter-claude-code-cli": patch
"@makaio/adapter-claude-agent-sdk": patch
---

Thread the turn pipeline's native-resume decision end-to-end into connectors. `ConnectorSendMessageOptions`/`ConnectorStartOptions` (and `MessageHandle`) gain a `useNativeResume` flag set by `AgentTurnExecutor`: when `false`, a connector must not arm its pending start-time resume target (`resumeAdapterSessionId`) for that dispatch — the caller replaced the provider thread with injected history, and natively resuming anyway doubled the conversation context. Both Claude connectors honor the flag by discarding the unconsumed resume target one-shot and minting a fresh provider session (the Agent SDK connector rotates an already-armed query); a generation's own provider-confirmed session continuity and approved `nativeFork` directives are unaffected.

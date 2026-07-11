---
"@makaio/adapter-codex-app-server": patch
"@makaio/adapter-anthropic-sdk": patch
"@makaio/adapter-cursor-sdk": patch
"@makaio/adapter-gemini-sdk": patch
"@makaio/adapter-github-copilot-sdk": patch
"@makaio/adapter-openai-node": patch
"@makaio/adapter-pi-sdk": patch
"@makaio/contracts": patch
"@makaio/framework": patch
---

Harden message-addressed turn admission, assistant-persistence settlement, canonical connector
message identity, and adapter completion correlation so concurrent messages cannot race
finalization, lose typed errors, wait on inapplicable fallbacks, or emit duplicate completion events.

Turn completion is now addressed by admitted message/agent pairs. This removes the legacy
agent-only `TurnStateChange`, `markAgentCompleted`, and `markAgentErrored` surface in favor of the
exported `TurnPairStateChange`, `TurnPairTerminalOutcome`, and `recordPairTerminal` contract.

Imported, completed, and closed turns now release pending assistant-response accumulators without
duplicating imported storage or persistence-settlement events.

---
"@makaio/contracts": minor
"@makaio/ai-adapters-core": minor
"@makaio/ai-adapters-claude-shared": minor
"@makaio/ai-adapters-stream-session": minor
"@makaio/adapter-openai-node": minor
"@makaio/adapter-anthropic-sdk": minor
"@makaio/adapter-codex-app-server": minor
"@makaio/adapter-cursor-sdk": minor
"@makaio/adapter-gemini-sdk": minor
"@makaio/adapter-github-copilot-sdk": minor
"@makaio/adapter-pi-sdk": minor
"@makaio/adapter-qwen-acp": minor
"@makaio/adapter-claude-agent-sdk": minor
"@makaio/adapter-claude-code-cli": minor
"@makaio/adapter-claude-code-tmux": minor
"@makaio/extension-telemetry-otel": minor
"@makaio/extension-opencode": minor
"@makaio/framework": minor
---

Declare truthful measurement granularity on every `agent.usage` event via a new mandatory `granularity` field (`provider-call`, `turn-aggregate`, `query-aggregate`, `latest-request-gauge`), projected to OTel as `llm.usage.granularity`, so downstream analytics can partition additive per-call deltas from turn/query aggregates and lossy gauges instead of summing them blindly. Provider-reported monetary amounts now carry `costProvenance`, the Cursor adapter no longer fabricates a zero cost, the qwen-acp connector flushes usage before handle completion so workflow attribution reaches its events, and the OpenCode importer emits schema-complete usage payloads.

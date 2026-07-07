---
'@makaio/adapter-claude-agent-sdk': patch
'@makaio/ai-adapters-core': patch
---

Persist Claude SDK sessions by default so native fork and resume actually carry
conversation history. `persistSession` previously defaulted to `false`, so no
transcript was written and a fork/resume silently started a fresh session.
Ephemeral one-shot agents opt out via the `ephemeral` flag, now threaded through
to the connector session config.

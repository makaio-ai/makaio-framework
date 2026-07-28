---
'@makaio/ai-adapters-core': minor
'@makaio/adapter-anthropic-sdk': patch
'@makaio/adapter-claude-agent-sdk': patch
'@makaio/adapter-claude-code-cli': patch
'@makaio/adapter-claude-code-tmux': patch
'@makaio/adapter-codex-app-server': patch
'@makaio/adapter-cursor-sdk': patch
'@makaio/adapter-gemini-sdk': patch
'@makaio/adapter-github-copilot-sdk': patch
'@makaio/adapter-openai-node': patch
'@makaio/adapter-pi-sdk': patch
---

Give conformance adapters the provider and client identity they ship.

Conformance builds an adapter directly instead of booting it, so nothing
resolves its declared provider IDs into full definitions and nothing tells it
which client it runs as. Both were passed to the connector but not to the
adapter, so authentication delivery could only be resolved on the connector
path.

Starting an agent therefore failed twice over: the provider lookup searched an
empty list and reported the adapter as having no authentication declaration at
all, and once that was fixed the client-owned binding was rejected as belonging
to a different client.

Only two of the ten adapters that expose an orchestration factory built the
provider pairing, each with its own copy of the same loop and its own error
message. `resolveConformanceDefinitionProviders` is now exported from
`@makaio/ai-adapters-core` alongside `resolveConformanceTestPreset` and used by
every one of them, so an adapter cannot silently run its orchestration tests
without the declarations it ships.

Measured against the two adapters whose credentials resolve locally:
`claude-agent-sdk` went from 37 passing / 20 failing to 54 / 3, and
`claude-code-cli` from 29 / 28 to 46 / 11.

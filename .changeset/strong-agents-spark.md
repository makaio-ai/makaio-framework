---
"@makaio/adapter-claude-agent-sdk": patch
"@makaio/client-claude-code": patch
"@makaio/contracts": patch
"@makaio/framework": patch
"@makaio/agent-sdk": patch
"@makaio/sdk": patch
---

Harden the Agent SDK runtime, contracts, and live SDK validation paths.

**@makaio/adapter-claude-agent-sdk**
- Tightens MCP/session context handling for SDK-safe runtime reconfiguration.

**@makaio/client-claude-code**
- Accepts newer Claude Code system message subtypes without schema violations.

**@makaio/contracts**
- Adds SDK-safe model-registry contracts, tightens interrupt and MCP schemas, and exposes runtime-safe MCP session context types.

**@makaio/framework**
- Registers the public model-registry namespace at runtime and hardens session, adapter eviction, and extension discovery lifecycle seams.

**@makaio/agent-sdk**
- Adds the root export and hardens connection/runtime control behavior.

**@makaio/sdk**
- Refreshes generated SDK bindings for the tightened bus contracts.

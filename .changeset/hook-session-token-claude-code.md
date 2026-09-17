---
"@makaio/client-claude-code": minor
---

Bump the tool-response contract to 1.4.0 and declare `session.token` on `SessionStart`.

`CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_VERSION` advances from `1.3.0` to `1.4.0`.
`session.token` is added to the catalog `supportedInteractions` and to the
`SessionStart` client definition's `responseCapabilities`. It is deliberately
**not** declared on `SubagentStart`: Claude Code subagents share the parent
session's stdio MCP servers, which receive only `CLAUDE_CODE_SESSION_ID` and have
no path to the hook-only `agent_id`, so a subagent-scoped token could never be
retrieved. The composer's scope helper stays agent-aware so the declaration can
return once a consumer can learn the agent id.

The hook-response composer collects the highest-priority `session.token` effect,
gates it on the event's declared capabilities, and hands it to the injected
in-process token sink (`ClientSessionTokenSink` from `@makaio/subsystem-client`);
the token never travels as a bus payload and is never written to stdout. Claude
Code's native `hookSpecificOutput` fields are unchanged. Evidence for this
capability is established by unit tests of the composer and the token store;
live probe oracles are not applicable because the token is deliberately kept out
of the model's context window.

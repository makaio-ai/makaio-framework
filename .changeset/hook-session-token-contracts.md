---
"@makaio/contracts": minor
---

Add `session.token` canonical effect and `createSessionTokenEffect` builder.

`CanonicalEffectSchema` gains a new variant `{ kind: 'session.token', value: string }`.
`createSessionTokenEffect(value)` builds the effect. The effect is declared in
`responseCapabilities` of `SessionStart` for Claude Code; it is **not** declared
for Claude Code `SubagentStart` (subagents share the parent session's stdio MCP
servers, which receive only `CLAUDE_CODE_SESSION_ID` — no path exists to the
hook-only `agent_id`) and not on any Codex event (Codex passes no session id to
MCP subprocesses).

**In-process delivery.** Unlike `context.append`, a `session.token` effect is
never rendered to stdout. After effect reduction, the composer calls
`ClientSessionTokenSink.record(scope, token)` in-process — the token is never
placed on the bus, so the `MAKAIO_DEBUG` bus logger never sees the token value.
`ClientSessionTokenService` then serves it to MCP servers via the normal
`client.session.token.get` request.

**Bus subjects.** Only `client.session.token.get` is exposed on the bus (a normal
request, reachable by remote MCP servers). Recording happens in-process through
`@makaio/subsystem-client`, not through a bus subject.

`ClientSessionTokenScopeSchema` requires `clientId` (the stable client identity
such as `'claude-code'` or `'codex'`) alongside `adapterSessionId` and the optional
`agentId`. The `onSessionToken` scope type in both composers carries `clientId`.
Including the client id prevents two providers that share a provider-local session
id from colliding in the token store.

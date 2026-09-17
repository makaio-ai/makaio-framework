---
"@makaio/subsystem-client": minor
---

Add `ClientSessionTokenService` and `ClientSessionTokenSink` for in-process session token storage.

`ClientSessionTokenService` keeps session tokens in memory keyed by
`(clientId, adapterSessionId)` and an optional `agentId`. Including `clientId`
prevents two client providers that share a provider-local session id from
colliding in the store.

**In-process write path.** The service implements `ClientSessionTokenSink`, a
narrow write-only interface exported from `@makaio/subsystem-client`. Client
services receive `ClientSessionTokenSink` injected at construction time and call
`sink.record(scope, token)` directly after reducing a `session.token` effect —
the token is never placed on the bus, so the `MAKAIO_DEBUG` bus logger never sees
it.

**Read path.** `client.session.token.get { clientId, adapterSessionId, agentId? } → { token: string | null }`
is the only bus subject — a normal request reachable by remote MCP servers over the
WebSocket bus.

**Lifetime.** Entries are swept by a periodic TTL pass (24-hour idle threshold,
5-minute interval). Session-scoped entries have no dedicated end event and rely on
the TTL sweep. No subagent-completion cleanup handler is registered because no
client currently declares `session.token` on `SubagentStart`; the `agentId`
dimension is retained in the key builder so a future declaration requires no
contract change. A cap of 1000 entries is enforced by evicting the least recently
active entry on insert. When a `SessionStart` with `startMode: 'compact'` fires,
the composer calls `record` again, overwriting the previous entry.

**Capability declaration.** `session.token` is declared on `SessionStart` for
Claude Code only. It is not declared on `SubagentStart` (Claude Code subagents
share the parent session's stdio MCP servers, which receive only
`CLAUDE_CODE_SESSION_ID` — no path exists to the hook-only `agent_id`) and not
on Codex (Codex passes no session id to MCP subprocesses).

`ClientsCoreService.sessionTokens: ClientSessionTokenSink` is now exposed so that
the Claude Code and Codex package constructors can receive the sink.

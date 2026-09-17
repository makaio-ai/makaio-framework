---
"@makaio/client-codex": minor
---

Bump Codex hook-response contract to 1.3.0; add session.token composer sink without declaring the capability.

`CODEX_CONTRACT_VERSION` advances from `1.2.0` to `1.3.0`. `session.token` is
added to `supportedInteractions` in the catalog so the capability is known to
the subsystem.

The Codex hook-response composer gains a `session.token` sink: when the effect
is present it hands the token to the injected in-process `ClientSessionTokenSink`
and never serialises it into the native JSON payload rendered to stdout.

`session.token` is **not** declared in `responseCapabilities` for `SessionStart`
or `SubagentStart`. Codex passes no session id to its MCP subprocesses, so no
consumer can call `client.session.token.get` (which requires `adapterSessionId`).
Advertising the capability would make integrations treat it as end-to-end usable
when the lookup path is not available on this client. Declaring it here is the
only change needed once Codex exposes such a lookup key.

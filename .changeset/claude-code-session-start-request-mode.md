---
'@makaio/client-claude-code': minor
---

Pin Claude Code to 2.1.219 and make `SessionStart` a request-mode hook.

`SessionStart` previously ran observer-only: it was wired as
`makaio hook received claude-code SessionStart` and could not contribute
anything back to the session it announced. It now declares
`responseCapabilities: ['context.append']`, which moves it onto the
`hook handle` lane and lets contributors append context that the CLI consumes
at session start. Native output is `hookSpecificOutput.additionalContext` with
no decision fields — `SessionStart` has no permission to grant and is declared
non-blockable, so a closed-policy contributor cannot convert a failure there
into a deny the way it can on `PreToolUse`.

The claim is backed by a live probe against the pinned binary, not by reading
documentation: `probe/session-start-context-append.json` records
`observedEffects: ['context.append']` with a passing response-consumption
oracle. Bumping the pin invalidated every previously committed capture, so all
twelve claude-code scenarios were re-captured against 2.1.219 in the same run.

The managed-install pin and the detection range answer different questions and
are set independently. The pin is the version every declared capability was
probed against and governs what this client may claim; `binary.supportedVersions`
only decides which binaries it will drive, and stays at `^2.1.0`. An existing
2.1.x install is not probed by us, but it still runs every event this client
dispatches, so it keeps working. The floor is not arbitrary: because wiring is
derived statically from `responseCapabilities`, declaring a capability installs
`hook handle` for every accepted binary, so the range may only be widened to
versions where the declared capabilities exist. `SessionStart` shipped upstream
in 1.0.62 and has carried `hookSpecificOutput.additionalContext` since — the
whole `^2.1.0` range honours it.

The terminal `hook.handle` dispatch no longer carries a per-event switch. Which
events are request-capable is declared once, in `responseCapabilities`: it
decides the managed hook command and it is resolved again when matching
contributors. A dispatch table was a second, independently maintained copy of
that gate.

BREAKING for contributors that pinned the contract catalog entry by exact
version: `claude-code.tool-response` moves 1.0.0 → 1.1.0. The change is purely
additive — `SessionStart` joins `supportedInteractions` and `blockability`, and
every 1.0.0 contributor remains valid.

Existing installations wired with the old `hook received claude-code
SessionStart` command are migrated on the next wiring apply, which removes the
stale alternate sentinel before installing the handle-mode command.

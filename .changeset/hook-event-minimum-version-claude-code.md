---
"@makaio/client-claude-code": patch
---

Skip wiring hook events the installed Claude Code binary cannot fire.

`PostCompact` declares `minimumVersion: '2.1.76'` (the event was introduced in
2.1.76, above the `^2.1.0` supported-versions floor). `buildClaudeCodeWiringList`
and `applyClaudeCodeWiring` omit events whose `minimumVersion` lies above the
binary version resolved through `client.resolveBinary`; an unknown version wires
every event as before. `removeClaudeCodeWiring` still removes every declared
event so a downgraded binary is unwired cleanly.

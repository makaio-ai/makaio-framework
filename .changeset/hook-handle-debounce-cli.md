---
"@makaio/cli": patch
---

Apply the `--debounce-failure` cool-down to built-in `hook handle` and
`hook received` invocations.

When `--debounce-failure` is active and a hook call arrives within the cool-down
window, the CLI skips the bus health probe and the WebSocket connect and runs the
command with no bus, landing on the hook action's existing fail-open path. Commander
still parses and validates argv, so `--help`, a missing operand, an unknown option or
a malformed `--timeout` is reported exactly as it would be outside the window. A
`--fail-close` run always probes so it can still fail loudly.

After a hook run in which the bus was genuinely unavailable, the failure marker is
recorded so subsequent invocations within the window skip the probe; a run that
already skipped the probe never refreshes the marker, so the window expires.

Also classifies bus connection failures by their typed transport code rather than by
message text, so a mid-handshake disconnect or handshake timeout is no longer mistaken
for an authentication failure.

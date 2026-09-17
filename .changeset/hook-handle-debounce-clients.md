---
"@makaio/client-claude-code": patch
"@makaio/client-codex": patch
---

Add `--debounce-failure` to request-mode hook wiring.

Request-mode hook descriptors now include `--debounce-failure` in their root
flags alongside `--no-launch`. Generated `hook handle` commands carry both flags
so the CLI's failure-marker mechanism suppresses repeated bus probes during a
cool-down window when the server is unreachable.

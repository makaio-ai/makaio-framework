---
'@makaio/extension-client-hooks': patch
---

Give the `hook.received` observation a sub-budget inside `hook handle` (FACT-293)

`runClientHookHandleCommand` now bounds the `hook.received` observation wait to a
sub-budget — one quarter of the handle timeout, at most 250 ms — instead of the full
timeout. This matters because context-only hooks (e.g. `UserPromptSubmit`,
`SubagentStart`) run with a 1000 ms handle timeout, where the old behaviour could let a
slow observation silently steal most of the budget and cause `context.append` to be
dropped. An observation that overruns its sub-budget no longer aborts the handle
request; the emit continues detached (fail-open) and the handle round-trip proceeds with
the remaining time.

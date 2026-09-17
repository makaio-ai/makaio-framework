---
'@makaio/client-claude-code': patch
---

`SessionStart` now uses the default 5000 ms `hook handle` timeout instead of the
1000 ms context-only fast-fail budget. The shortened budget exists so a down server
does not stall every prompt and subagent spawn; `SessionStart` fires only at session
boundaries (startup, resume, clear, compaction) and is the event through which
consumers deliver session context, whose contributors routinely need more than one
second. The trade-off is a stall of up to 5 s per boundary while the server is down.
`UserPromptSubmit` and `SubagentStart` keep the 1000 ms budget.

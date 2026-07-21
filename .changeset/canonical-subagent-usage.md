---
"@makaio/contracts": major
"@makaio/extension-subagent": major
"@makaio/framework": major
---

Route subagent completion through canonical session turns and expose frozen delegate usage metrics.

- make `complete_task` a turn-correlated completion intent and add the non-terminal `completing` lifecycle state
- preserve cached-token and granularity-aware usage through subagent status, await, and workflow economics
- unify workflow delegate execution on the managed subagent lifecycle

---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": major
"@makaio/storage-pg": patch
"@makaio/subsystem-workflow-engine": major
---

Bind workflow gate responses to the Attempt that opened the gate.

Attempt-owned `workflow.gate.respond` calls must now include the matching
`executionAttemptId`. The workflow runtime persists and verifies that identity
before accepting an in-process or durable gate response, so a response for one
Attempt cannot resume another Attempt of the same execution. Legacy workflows
without an Attempt continue to use gate responses without this field.

Worker entrypoints pass their authority-created Attempt identity into the
workflow runtime. Consumers that create an Attempt-owned gate response directly
must preserve the `executionAttemptId` received with `workflow.gate.suspended`.

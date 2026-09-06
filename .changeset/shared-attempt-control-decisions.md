---
"@makaio/framework": minor
"@makaio/subsystem-workflow-engine": minor
---

Expose shared pure decision evaluators for runtime registration, operation admission,
operation completion, and runtime readiness through the existing execution-attempt
repository entrypoint. Host repository implementations can reuse the same refusal
and replay precedence while retaining responsibility for transactional reads and
guarded writes.

The in-memory and SQLite reference repositories now use these evaluators without
changing their mutation, fencing, or replay behavior. No bus subjects or persisted
schemas change.

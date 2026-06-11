---
"@makaio/contracts": minor
"@makaio/framework": minor
"@makaio/subsystem-workflow-engine": minor
---

Add worklog.stats RPC: time-windowed execution counts, duration, token and cost totals.

- `@makaio/contracts`: new `WorkLogStatsSchema`/`WorkLogStats` and the `worklog.stats` RPC subject (optional `workflowId`/`since`/`until` filters on execution `startedAt`).
- `@makaio/subsystem-workflow-engine`: `aggregateWorklogStats()` aggregates `worklog_summaries` via SQL (per-status counts plus duration/token/cost sums); handler registered with the worklog projection.

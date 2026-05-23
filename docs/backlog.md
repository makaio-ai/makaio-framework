## How to Use This Document

1. **Adding items:** Include source reference (plan doc or discussion)
2. **Prioritization:** Update Priority column when planning sprints
3. **Completion:** Delete the item when implemented (don't mark as "done" - this creates clutter)
4. **Design questions:** Resolve during implementation, update Notes
5. **Historical records:** Completed features are documented in `docs/plans/done/`, not here

---

# Backlog

Future work, seams, and open design questions.

> **This document tracks PENDING items only.** Completed work should be removed, not marked as "done".
> For historical records of completed features, see `docs/plans/done/`.
> Items tagged **QUICK WIN** are high-priority pending items suitable for a single focused session.

---

## Workflow Engine Follow-Ups

| Item | Priority | Source | Notes |
|---|---|---|---|
| Decide central migration strategy for fresh-baseline rewrites | High | Review of `storage/migrations/drizzle/meta/_journal.json` and `storage/migrations/src/apply-migrations.ts`; `docs/plans/2026-05-23-workflow-agent-steps-dynamic-fanout-implementation-plan.md` Task 4 | Existing DBs that already applied the old `0000` can adopt the new migration hash after the first existing `CREATE`, skipping later new workflow tables. Choose incremental migrations, reset-only dev policy enforcement, or migration adoption changes before archiving the plan. |
| Decide whether normalized `workflow_execution_steps` is the accepted execution-state storage model | High | Plan expansion metadata decision vs. `subsystems/workflow-engine/src/storage/schema.ts` | The plan said to avoid a new table until JSON size proved it necessary. Implementation now stores step rows separately while retaining the execution JSON snapshot. Re-approve and update design docs, or revert to the plan model. |
| Add boot-time workflow crash recovery scanner | High | Plan explicit non-goal; `subsystems/workflow-engine/src/workflow-scheduler-rebuild.ts` | Rebuild primitives exist, but startup does not load persisted running executions or resume/terminalize them. |
| Resolve unbounded cross-scope workflow definition listing | Medium | Review of `WorkflowListQuerySchema` and `storage/handler.ts` definition list path | Execution listing is scoped/bounded; definition listing can return all definitions without scope or pagination. Decide whether admin/global listing is intentional, then require scope or add pagination. |
| Add workflow public bus coverage for execution listing and scoped start | Medium | Test coverage review | Storage tests cover bounded listing well; add `WorkflowSubjects.listExecutions` tests and a `WorkflowSubjects.start` scope override test that asserts persisted `execution.scope`. |
| Add recovery-source coverage for scheduler rebuild beyond node keys | Medium | Test coverage review | `rebuildSchedulerGraph()` now restores `stepContext`; add a resumed-scheduling test that uses persisted expansion snapshots without re-evaluating collection. |
| Add workflow resource-cleanup coverage for fail-fast and cancellation | Medium | Test coverage review | Capture `SubagentSubjects.kill`, shell abort cleanup, and gate release when a sibling fails or execution is cancelled. |
| Add scheduler integration coverage for for-each concurrency batching | Medium | Test coverage review | Helper tests cover generated dependency edges; add live scheduler cases for `concurrency: 1` and `concurrency: 2`. |
| Add same-timestamp execution pagination coverage | Medium | Test coverage review | Current cursor tests use distinct timestamps. Add a tie-breaker test for `startedAt desc, id desc`. |
| Add adapter harnessId read-after-storage regression | Medium | Test coverage review | Current adapter test captures `AgentStorageSubjects.set`; add storage-backed `AgentStorageSubjects.get` coverage if the local test harness can register real agent storage cheaply. |
| Decide listExecutions invalid-limit semantics and centralize constants | Medium | AI review triage | Current contract rejects limits outside `1..500` and the storage handler mirrors that. If clamping is desired, update schema, handler, and tests together; either way share default/min/max constants. |
| Remove redundant left-prefix indexes from source schemas and regenerate central migrations | Medium | AI review triage | Candidate redundant indexes: `idx_client_binary_versions_client_id`, `idx_client_profiles_client_id`, `idx_sessions_source`, `idx_workflow_execution_steps_execution_id`, `idx_workflow_step_spans_execution_id`, `idx_workflow_execution_links_source`. Remove in source schemas, not only generated SQL. |
| Add workflow agent-step usage telemetry ingestion | Low | Plan explicit non-goal; agent-step design doc future section | Span tables have token/cost/tool-call fields, but no event ingestion from agent usage yet. |
| Add TypeScript `defineWorkflow()` authoring API | Low | Plan explicit non-goal; workflow design docs | Type-safe authoring should compile to the same workflow primitives. |
| Decide same-agent workflow resume semantics | Low | Plan explicit non-goal | Current `contextMode` supports `fresh` and `fork`; resuming the same agent/session needs a separate contract. |
| Decide composite expansion UI/public lifecycle surface | Low | Plan explicit non-goal | Current public step lifecycle remains executable-only; UI can infer from persisted execution snapshots until a live composite surface is designed. |
| Support non-local execution targets for subagents | Low | `services/core/src/subagent/subagent-service.ts` | Workflow agent steps now route through SubagentService, which currently rejects non-local execution targets. |
| Define subagent child-session shutdown behavior on completion/cancellation | Low | `services/core/src/subagent/subagent-service.ts` review markers | Manager state cleanup exists; explicit child session termination remains a lifecycle decision. |

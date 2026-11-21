---
"@makaio/framework": minor
"@makaio/contracts": minor
---

The contracts export the identifiers of a job run and of a step, and the life cycle of a job run.

`JobRunId` and `StepId` come with their schemas `JobRunIdSchema` and `StepIdSchema`. `JobRunLifecycleState`
with `JobRunLifecycleStateSchema` has the states `ordered`, `running`, `completed`, `lost` and `cancelled`. The
life cycle is not the outcome of the workflow: a run that delivered a result with the outcome `completed` or
`failed` is `completed`.

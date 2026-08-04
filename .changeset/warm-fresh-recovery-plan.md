---
'@makaio/services-core': major
---

Model agent recovery as an explicit `RecoveryPlan` so the rehydrate call and the
history that accompanies it consume one decision.

Recovery always had two consumers of the same question — "does the replacement
connector continue the provider conversation, or start fresh with the stored one
injected?" — and they read two separate values: an optional
`resumeAdapterSessionId` on the rehydrate side, and "was this agent recovered?"
on the history side. They agreed only because no caller ever set a resume target
on a path that also built history.

`RecoveryPlan` is now that decision: `native-resume` (carrying the provider
session to resume, no history) or `fresh-with-history` (fresh connector, full
stored conversation injected). `planAgentRecovery` derives it from a locality
verdict plus the agent's own provider session, `recoveryPlanResumeTarget` feeds
`adapter.rehydrateAgent`, and the new `buildPlannedRecoveryContext` feeds the
next turn — so a natively resumed agent can no longer be handed a conversation
the provider already holds, and a fresh one can no longer start blank.

Breaking: `RecoveryConfig.resumeAdapterSessionId` is replaced by a required
`plan` field. Callers that passed no resume target pass
`FRESH_WITH_HISTORY_RECOVERY_PLAN`; callers that evaluated locality use
`planAgentRecovery`.

`session.restartAgents` now reports failure for an agent whose session row
cannot be read (previously it rehydrated the agent eagerly with no resume target
and no history — alive but blank). The send-path recovery resolves its targets
from the session row's agents, so an orphaned agent record has no reachable
recovery path; a green result would hide a dead connector.

---
"@makaio/contracts": major
"@makaio/subsystem-workflow-engine": major
"@makaio/framework": major
"@makaio/runtime-node": major
"@makaio/bus-transport-websocket": minor
---

Keep provider responsibility independent of an ExecutionAttempt's canonical
settlement. Provider operations resolve only when both positive, claim-fenced
completion evidence and attempt settlement exist. Evidence received first is
stored immediately and remains recoverable without an in-process outcome waiter.

Repository implementations must persist nullable `completionEvidence`, implement
`completeProviderOperation` and the bounded `listOpenProviderOperations` selector,
and retain unresolved provider operations across settlement and restart. Existing
`getRecoverableAttempts` semantics remain limited to unsettled allocated attempts.
Both reference stores and the shared conformance suite cover the new contract.
Completion-only absence and process-loss decisions preserve existing outcomes
and their owner-convergence waiters instead of reporting a new abandonment.

Worker handles expose optional replaying completion and local-observation-loss
observers. `release()` detaches process-local resources only: it must not cancel
the allocation or revoke credentials still needed by a running Worker. Terminal
infrastructure evidence and cancellation acknowledgements do not prove that all
provider responsibilities are complete. Piscina reports positive completion only
after runner settlement, the bounded outcome-delivery operation has ended, and
final identity cleanup. Its evidence distinguishes acknowledged delivery from
exhausted delivery; provider completion never fabricates an accepted job result.

Add generation-fenced HMAC cleanup capture and its execution-scoped runtime
wrapper so a replacement local controller can adopt final credential cleanup
without revoking a later credential rotation. No secrets are returned by these
helpers. The existing workflow-shaped start API and Bus subjects are unchanged.

Same-attempt recovery attachment may finish outstanding provider cleanup for a
known allocation whose resource is already terminal or absent. Absent-resource
cleanup is limited to settled attempts with unresolved provider operations.
Attachment does not create, restart, delete, or announce runtime readiness;
inspection stays read-only and absence alone is not positive completion proof.

Allocation inspection may return a more precise reference to the same provider
allocation. Recovery persists this through the existing claim-fenced reference
evolution operation and ends the pass before further control. This lets a later
pass recover GitHub dispatches whose run ID was not correlated before handoff,
without dispatching another workflow or introducing a new recovery obligation.

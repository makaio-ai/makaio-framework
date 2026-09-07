---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/subsystem-workflow-engine": major
"@makaio/runtime-node": major
---

Separate an Attempt's immutable workload instruction, optional project Workspace
Preparation, and admitted workload Invocation. Workflow executable acquisition
remains inside the installed workflow adapter; it does not imply a project
Workspace.

Breaking changes:

- Attempt creation requires a portable instruction. Repository implementations
  must persist it and Preparation receipts, expose instruction reads and atomic
  Preparation result acceptance, and enforce the optional commit-time Runtime
  fence used by Runtime outcome submission.
- Add `execution-attempt.instruction.get`, `execution-attempt.operation.report`,
  and `execution-attempt.outcome.submit`. Generic outcomes distinguish workload
  results, technical failures, and observed cooperative cancellation. Outcome
  acknowledgement still follows durable commit and owner convergence.
- Add `worker.runtime.inputs.get` for frozen non-secret contribution manifest and
  suspension strategy. Hosts freeze that selection in their existing provisioning
  binding and reconstruct provider requests from the instruction plus binding,
  not mutable latest workflow source or inputs. Owner continuation inputs remain available
  for constructing a later Attempt.
- Workflow-owned Authorities and host repositories use `WorkflowAttemptOutcome`.
  Technical failures and cancellation remain distinct canonical outcomes;
  existing runner-result projections happen only after convergence. Startup
  failures and cancellation can settle without successfully decoding workload
  input; workload-produced results still require matching instruction identity.
- `IWorkflowRunner` may declare its terminal ownership before launch. Owner start
  persists the selected runner's ownership before dispatch, rather than relying
  on a late provider override. Resume preserves that ownership and rejects an
  incompatible runner before starting another Attempt; omitted ownership uses
  the worker completion protocol.
- `WorkerRunnerOptions.readRunContext` receives the runner's AbortSignal as its
  second argument. Custom readers must forward it to pending owner-context reads;
  cancellation before Attempt creation does not enter dispatch or ACK recovery.
- The headless worker returns `{ outcome, decision }`, not `{ result, decision }`.
  The generic Runtime supports no-Workspace execution and explicit local
  bind/create, single-source-root Setup. Owned files are not removed after an
  unacknowledged or technical outcome, or while preservation obligations remain.
- Headless workflow dependencies require an explicit private `workflowEnv` map.
  The existing authenticated bootstrap claim response carries `runtimeEnv`;
  hosts resolve it independently from durable instructions and non-secret Runtime
  selection. Configured owner environment is preserved and explicit host values
  take precedence, without copying ambient process variables.
- Generic Invocation and the headless harness accept an optional private
  `setupEnv` map for host-selected Setup values. It is forwarded only to local
  Setup, never persisted in instructions or receipts, and is independent of
  `workflowEnv`. Existing ambient inheritance is unchanged when it is omitted.
- Public Runtime entrypoints expose `AuthorityRequestDeliveryError` for
  non-terminal Authority-request deadlines, separately from outcome-delivery
  errors. Custom Preparation objects retain their method receiver when invoked.
  Cooperative cancellation thrown by custom Preparation or Setup uses the same
  signal-based classification as Invocation; unrelated failures remain technical.

Git source acquisition, durable cancellation commands, capture backends, and
new readiness-event publication remain separate integration work.

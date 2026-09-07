---
"@makaio/contracts": major
"@makaio/framework": major
"@makaio/runtime-node": major
"@makaio/services-core": major
"@makaio/subsystem-workflow-engine": major
"@makaio/bus-transport-websocket": patch
---

Make Runtime start permission an explicit ExecutionAttempt decision, separate
from receiving credentials, registering a Runtime, proving readiness, and
admitting work.

Breaking changes:

- Add `execution-attempt.bootstrap.awaitStart`. Attempt-authenticated clients
  receive `permitted`, `pending`, or a non-secret `refused` reason. Permission
  allows proceeding to registration; it is not readiness or an operation grant.
- Change `worker.control.bootstrap.claim` to a strict `granted`, `pending`, or
  `refused` response. Only `granted` carries `{ credentials, runtimeEnv }`.
  Connectors and credential issuers use the separately exported credentials-only
  payload; the private Runtime environment stays on the authenticated handoff.
- Authority construction and repository Attempt creation require an explicit
  `bootstrapTimeoutMs`. Hosts expose `executionAttemptBootstrapTimeoutMs` when
  constructing an Authority from a repository. There is no framework default.
- Repository implementations must capture one creation instant, persist an
  immutable `bootstrapDeadlineAt`, and implement coherent owner-fenced
  `readBootstrapStartState`. Missing legacy deadlines cannot authorize a new
  bootstrap; unrelated reads, recovery and already-running operations retain
  their existing behavior. Host storage adapters must satisfy this contract
  before adopting the release.
- Provider requests, Attempt-bound thread dispatch, headless dependencies and
  workflow-container spawn requests carry that same absolute deadline. Recovery,
  credential claims and reconnects do not renew it. Unbound workflows and
  session-only containers do not acquire an invented Attempt or deadline.
- Recovery receives a shared `WorkerProviderContext`, while new provisioning
  requires the additional deadline in `WorkerProvisionRequest`. Existing
  allocations remain inspectable and releasable even when their legacy Attempt
  has no bootstrap deadline; recovery never invents one to rebuild its context.
- Replace the registration client's allocation-visibility retry with the final
  authenticated start barrier. Bounded pre-registration reconnect handles typed
  transport failures only; authentication refusals and malformed responses stop
  bootstrap. No registration or workload replay is added.
- Preserve policy-close code `1008` as a nonretryable transport failure for a
  pending request on an established connection with automatic reconnect disabled.
  Buffered responses still get their existing opportunity to complete first.

The bootstrap budget ends at timely final start permission. Registration,
readiness probes, optional Workspace Preparation, Invocation and outcome
acknowledgement retain their own bounds and authority fences. No provider
activation method, additional readiness event, durable cancellation protocol or
exclusive connection ownership is introduced.

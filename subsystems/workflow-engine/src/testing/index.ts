/**
 * `@makaio/framework/workflow-engine/testing`
 *
 * Test-only realizations of the durable execution attempt port, plus the
 * fixtures that drive them.
 *
 * The port is a specification: a host application supplies the durable
 * implementation, and every one of them owes the same decisions. This subpath
 * ships `createInMemoryAttemptRepository` — the reference state machine. Fast,
 * deterministic, and the right double for tests about behaviour above the
 * port.
 *
 * The transactional realization lives on `../testing/sqlite` instead, because
 * importing it pulls in a database driver that most suites never call. A test
 * that must prove fencing survives real concurrency reaches for that subpath
 * explicitly.
 *
 * Neither realization is production persistence.
 *
 * `INITIAL_ATTEMPT_CONTROL_STATE` ships alongside them because an attempt
 * record carries the port's ten control members as required facts. A test that
 * hands a double a record it built itself states them by spreading this, which
 * is the state a freshly created attempt holds, rather than inventing ten
 * values of its own.
 * @packageDocumentation
 */

export { INITIAL_ATTEMPT_CONTROL_STATE } from './attempt-record-codec.js';
export { requireCommittedOutcome } from './committed-outcome.js';
export { createInMemoryAttemptRepository } from './in-memory-attempt-repository.js';
export type { InMemoryAttemptRepository, InMemoryAttemptRepositoryState } from './in-memory-attempt-repository.js';
export {
  allocateTestAttempt,
  beginTestProvisioning,
  driveTestAttemptToAllocated,
  leaseAt,
  makeBeginProvisioningInput,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestInstruction,
  makeTestWorkflowResult,
  TEST_OWNER_ID,
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
  workflowRunResultOutcomeCodec,
} from './attempt-fixtures.js';
export type { AttemptAllocationDriver, ProvisioningClaimGrantor } from './attempt-fixtures.js';

/**
 * `@makaio/subsystem-workflow-engine/testing`
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
 * @packageDocumentation
 */

export { createInMemoryAttemptRepository } from './in-memory-attempt-repository.js';
export type { InMemoryAttemptRepository, InMemoryAttemptRepositoryState } from './in-memory-attempt-repository.js';
export {
  beginTestProvisioning,
  leaseAt,
  makeBeginProvisioningInput,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestWorkflowResult,
  TEST_OWNER_ID,
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
} from './attempt-fixtures.js';
export type { ProvisioningClaimGrantor } from './attempt-fixtures.js';

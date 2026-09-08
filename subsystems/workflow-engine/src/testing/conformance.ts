/**
 * `@makaio/framework/workflow-engine/testing/conformance`
 *
 * Callable Vitest requirements for host-owned execution attempt persistence.
 * Import this leaf from a Vitest test file; the reference repository subpaths
 * remain usable without loading Vitest or registering tests.
 * @packageDocumentation
 */
import { describe } from 'vitest';
import { workflowRunResultOutcomeCodec } from './attempt-fixtures.js';
import { useHarness } from './conformance/harness.js';
import { registerInstructionCases } from './conformance/instruction-cases.js';
import { registerClaimCases } from './conformance/claim-cases.js';
import { registerClaimExpiryCases } from './conformance/claim-expiry-cases.js';
import { registerPreparationBindingCases } from './conformance/preparation-binding-cases.js';
import { registerAtomicityCases } from './conformance/atomicity-cases.js';
import { registerAllocationCases } from './conformance/allocation-cases.js';
import { registerEvidenceCases } from './conformance/evidence-cases.js';
import { registerRecoveryCases } from './conformance/recovery-cases.js';
import { registerAdmissionCases } from './conformance/admission-cases.js';
import { registerTerminalCases } from './conformance/terminal-cases.js';
import { registerReadinessCases } from './conformance/readiness-cases.js';
import { registerOutcomeCases } from './conformance/outcome-cases.js';
import { registerNormalizingCases } from './conformance/normalizing-cases.js';
import { registerGenerationCases } from './conformance/generation-cases.js';
import { registerUrlCases } from './conformance/url-cases.js';
import { registerBytesCases } from './conformance/bytes-cases.js';
import { registerCorruptionCases } from './conformance/corruption-cases.js';
import { registerTerminalAtomicityCases } from './conformance/terminal-atomicity-cases.js';
import { registerProviderBoundaryCases } from './conformance/provider-boundary-cases.js';
import { registerRuntimeBoundaryCases } from './conformance/runtime-boundary-cases.js';
import { registerRuntimeIdentityCases } from './conformance/runtime-identity-cases.js';
import { registerPreparationRefusalCases } from './conformance/preparation-refusal-cases.js';
import { registerProviderAtomicityCases } from './conformance/provider-atomicity-cases.js';
import { registerCreationAtomicityCases } from './conformance/creation-atomicity-cases.js';
import { registerTimestampCases } from './conformance/timestamp-cases.js';
import { registerPreparationIsolationCases } from './conformance/preparation-isolation-cases.js';
import { registerMemberOrderCases } from './conformance/member-order-cases.js';
import { registerRecoveryOrderCases } from './conformance/recovery-order-cases.js';
import { registerSettlementReplayCases } from './conformance/settlement-replay-cases.js';
import { registerBootstrapStartStateCases } from './conformance/bootstrap-start-state-cases.js';
import { registerMixedAuthorityRaceCases } from './conformance/mixed-authority-race-cases.js';
import { registerOwnerRequestCases } from './conformance/owner-request-cases.js';
import { registerOwnerResultRecoveryCases } from './conformance/owner-result-recovery-cases.js';
import { registerProviderCompletionCases } from './conformance/provider-completion-cases.js';
import type { ExecutionAttemptRepositoryContractFactory } from './conformance/types.js';

export type {
  ExecutionAttemptRepositoryContractFactory,
  ExecutionAttemptRepositoryContractHarness,
  RecoverableAttemptsSeed,
} from './conformance/types.js';

/**
 * Register repository conformance tests synchronously in a Vitest test file.
 *
 * The factory is invoked during setup, once per contract group, with fresh
 * storage and the group's codec. The suite checks the recovery-capable port's
 * persistence semantics, including immutable instructions, Preparation receipts, runtime fences,
 * competing controllers, and owner-defined outcome representations. Driver or
 * schema-specific assertions remain the adapter's own responsibility.
 * @param factory - Named realization and its isolated-storage factory.
 */
export function runExecutionAttemptRepositoryContract(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt port parity (${factory.name})`, () => {
    const getHarness = useHarness(factory, workflowRunResultOutcomeCodec);
    registerInstructionCases(getHarness);
    registerClaimCases(getHarness);
    registerClaimExpiryCases(getHarness);
    registerPreparationBindingCases(getHarness);
    registerAtomicityCases(getHarness);
    registerAllocationCases(getHarness);
    registerEvidenceCases(getHarness);
    registerRecoveryCases(getHarness);
    registerAdmissionCases(getHarness);
    registerTerminalCases(getHarness);
    registerReadinessCases(getHarness);
    registerTerminalAtomicityCases(getHarness);
    registerProviderBoundaryCases(getHarness);
    registerRuntimeBoundaryCases(getHarness);
    registerRuntimeIdentityCases(getHarness);
    registerPreparationRefusalCases(getHarness);
    registerProviderAtomicityCases(getHarness);
    registerCreationAtomicityCases(getHarness);
    registerTimestampCases(getHarness);
    registerPreparationIsolationCases(getHarness);
    registerRecoveryOrderCases(getHarness);
    registerSettlementReplayCases(getHarness);
    registerBootstrapStartStateCases(getHarness);
    registerMixedAuthorityRaceCases(getHarness);
    registerOwnerRequestCases(getHarness);
    registerProviderCompletionCases(getHarness);
  });
  registerOutcomeCases(factory);
  registerNormalizingCases(factory);
  registerGenerationCases(factory);
  registerUrlCases(factory);
  registerBytesCases(factory);
  registerCorruptionCases(factory);
  registerMemberOrderCases(factory);
  registerOwnerResultRecoveryCases(factory);
}

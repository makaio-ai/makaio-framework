import { WorkflowError, WorkflowErrorCode } from '@makaio/contracts';
import type { Launcher } from '@makaio/subprocess';
import { bindCheckoutWorkflow, type CheckoutWorkflowBinding } from './checkout-workflow-reader.js';
import {
  runCodeStepProcess,
  type CheckoutStepExchange,
  type CodeStepProcessResult,
  type LocalCodeStepInvocation,
} from './code-step-process.js';
import type { CheckoutCodeStepInput } from './step-interface-schemas.js';

/** The worker's launch policy and the source preparation facts for one step. */
export interface CheckoutCodeStepInvocation extends Omit<LocalCodeStepInvocation, 'env'> {
  readonly binding: CheckoutWorkflowBinding;
  /** Commit reported by the fixed operation that prepared the selected root. */
  readonly preparedSource: { readonly rootId: string; readonly revision: string };
  readonly step: Omit<CheckoutCodeStepInput, 'source'>;
  readonly onRequestRefused: CheckoutStepExchange['onRequestRefused'];
}

/**
 * Run one checkout step only after the prepared revision matches the frozen source.
 * The checkout launch supplies an empty environment allowlist. The execution
 * site still sets its owner directories. A future launch profile supplies any
 * additional allowlist entries.
 * @param launcher - Worker-owned execution site.
 * @param invocation - Step data, preparation evidence and trusted entry command.
 * @returns The validated result from the launched step process.
 */
export async function runCheckoutCodeStep(
  launcher: Launcher,
  invocation: CheckoutCodeStepInvocation,
): Promise<CodeStepProcessResult> {
  const { binding, preparedSource, step, onRequestRefused, ...launch } = invocation;
  const source = bindCheckoutWorkflow(binding);
  if (
    preparedSource.rootId !== binding.sourceRootId ||
    preparedSource.revision.toLowerCase() !== binding.gitRevision?.toLowerCase()
  ) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Prepared checkout does not match the frozen revision');
  }
  return runCodeStepProcess(launcher, { ...launch, env: {} }, { input: { ...step, source }, onRequestRefused });
}

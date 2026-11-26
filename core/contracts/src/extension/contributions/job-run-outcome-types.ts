import type { JobRunCapability, JobRunOutcomeHandler } from '../../workflow/job-run-outcome.js';
import type { ExtensionContext } from '../extension-context.js';

/**
 * In-process outcome intake registered under the extension's activation identity.
 * @typeParam TContext - Context supplied by the host.
 */
export interface ExtensionJobRunOutcomeContribution<TContext extends ExtensionContext> {
  /**
   * Build the handler for this activation. Open the owner transaction inside the
   * handler, apply owner effects there, and close through the invocation's port.
   * Roll back that transaction before returning a refusal. Return acceptance
   * only after the transaction commits.
   * @param ctx - Activating extension's context.
   * @param jobRuns - Generation-bound port for endings without a result.
   */
  readonly createHandler: (
    ctx: TContext,
    jobRuns: JobRunCapability,
  ) => JobRunOutcomeHandler | Promise<JobRunOutcomeHandler>;
}

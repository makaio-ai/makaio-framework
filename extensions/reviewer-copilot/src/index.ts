/**
 * \@makaio/reviewer-copilot
 *
 * Framework extension that registers the Copilot reviewer processor.
 *
 * The processor transforms inline VCS review comments authored by
 * `copilot-pull-request-reviewer[bot]` into {@link ReviewFinding} arrays.
 * It extracts suggestion blocks as structured {@link SuggestedChange} entries
 * and treats all findings as `'minor'` severity (Copilot has no severity tiers).
 *
 * Review bodies are skipped — Copilot bodies contain summary tables and
 * walkthrough prose, not actionable per-line findings.
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts/extension';
import { registerReviewerProcessor, unregisterReviewerProcessor } from '@makaio/contracts';
import { copilotProcessor } from './processor.js';

export { copilotProcessor } from './processor.js';

/**
 * Makaio extension that registers the Copilot reviewer processor.
 *
 * On `init`, emits a capability registration event on the bus so the review
 * service can dispatch Copilot snapshots to this processor.
 */
export const reviewerCopilotPackage: MakaioExtension = {
  name: 'reviewer-copilot',
  displayName: 'Copilot Reviewer Processor',
  version: '0.1.0',

  /**
   * Creates the extension service.
   *
   * Defers processor registration to `init` so it runs after all packages
   * have loaded and the capability registry is accepting registrations.
   * @param ctx - Runtime context supplying the application bus.
   * @returns Service lifecycle with an `init` hook for processor registration.
   */
  create(ctx) {
    return {
      async init() {
        await registerReviewerProcessor(ctx.bus, copilotProcessor);
      },
      async destroy() {
        await unregisterReviewerProcessor(ctx.bus, copilotProcessor.id);
      },
    };
  },
};

export default reviewerCopilotPackage;

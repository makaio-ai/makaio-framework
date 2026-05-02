/**
 * \@makaio/reviewer-coderabbit
 *
 * Framework extension that registers the CodeRabbit reviewer processor with
 * the capability bus. Implements {@link IReviewerProcessor} for stateless
 * transformation of CodeRabbit VCS data into normalized {@link ReviewFinding}
 * records.
 * @packageDocumentation
 */

import type { MakaioExtension } from '@makaio/contracts/extension';
import { registerReviewerProcessor, unregisterReviewerProcessor } from '@makaio/contracts';
import { codeRabbitProcessor } from './processor.js';

export { codeRabbitProcessor } from './processor.js';
export {
  buildMessage,
  contentHash,
  extractDetailsBlock,
  extractDiffSuggestions,
  extractExplanation,
  extractSummaryLine,
  parseDiffSuggestions,
  parseNitpickSection,
  parseRateLimitFromBody,
  parseSeverity,
  stripCodeRabbitMetadata,
  commentToFinding,
} from './processor.js';

/**
 * Makaio extension descriptor for the CodeRabbit reviewer processor.
 *
 * Registers {@link codeRabbitProcessor} with the capability bus during
 * extension initialization so the review service can discover and use it
 * for transforming CodeRabbit VCS data into normalized findings.
 */
export const reviewerCodeRabbitPackage: MakaioExtension = {
  name: 'reviewer-coderabbit',
  displayName: 'CodeRabbit Reviewer Processor',

  /**
   * Creates the extension service.
   *
   * Registers the CodeRabbit processor with the capability bus so the review
   * service can discover it via {@link REVIEWER_PROCESSOR_CAPABILITY_ID}.
   * @param ctx - Extension context providing the bus instance
   * @returns Service lifecycle with `init` hook for processor registration
   */
  create(ctx) {
    return {
      async init() {
        await registerReviewerProcessor(ctx.bus, codeRabbitProcessor);
      },
      async destroy() {
        await unregisterReviewerProcessor(ctx.bus, codeRabbitProcessor.id);
      },
    };
  },
};

export default reviewerCodeRabbitPackage;

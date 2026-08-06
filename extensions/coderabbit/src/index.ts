import type { IMakaioBus } from '@makaio/bus-core';
/**
 * \@makaio/extension-coderabbit
 *
 * Framework extension that registers the CodeRabbit review source and reviewer
 * processor with the capability bus. Implements {@link IReviewSource} for
 * VCS-agnostic snapshot fetching and {@link IReviewerProcessor} for stateless
 * transformation of CodeRabbit VCS data into normalized {@link ReviewFinding}
 * records.
 * @packageDocumentation
 */

import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { dep } from '@makaio/contracts/extension';
import {
  CapabilitySubjects,
  REVIEWER_PROCESSOR_CAPABILITY_ID,
  REVIEW_SOURCE_CAPABILITY_ID,
  registerReviewSource,
  unregisterReviewSource,
  registerReviewerProcessor,
  unregisterReviewerProcessor,
} from '@makaio/contracts';
import { createCodeRabbitReviewPostedTrigger } from './automation-trigger.js';
import { codeRabbitProcessor } from './processor.js';
import { CodeRabbitSource } from './source.js';

export {
  CODERABBIT_REVIEW_POSTED_TRIGGER_KIND,
  CodeRabbitReviewPostedEventSchema,
  createCodeRabbitReviewPostedTrigger,
} from './automation-trigger.js';
export type { CodeRabbitReviewPostedEvent } from './automation-trigger.js';
export { codeRabbitProcessor } from './processor.js';
export { CODERABBIT_REVIEWER, CodeRabbitSource } from './source.js';

/**
 * Makaio extension descriptor for the CodeRabbit integration.
 *
 * Registers {@link CodeRabbitSource} and {@link codeRabbitProcessor} with the
 * capability bus during extension initialization so the review service can
 * discover and use them for fetching and transforming CodeRabbit review data
 * into normalized findings, and contributes the executable
 * `coderabbit.review-posted` automation trigger that turns arrived CodeRabbit
 * findings into a workflow start condition.
 */
export const coderabbitPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'coderabbit',
  displayName: 'CodeRabbit',
  version: '0.1.0',
  dependencies: [dep('review')],

  /**
   * Creates the extension service.
   *
   * Registers the CodeRabbit review source and processor with the capability
   * bus so the review service can discover them via the capability registry.
   * @param ctx - Extension context providing the bus instance.
   * @returns Service lifecycle with `init` and `destroy` hooks.
   */
  create(ctx) {
    const source = new CodeRabbitSource(ctx.bus);
    return {
      async init() {
        const hadSource = await hasRegisteredCapabilityProvider(ctx.bus, REVIEW_SOURCE_CAPABILITY_ID, source.id);
        const hadProcessor = await hasRegisteredCapabilityProvider(
          ctx.bus,
          REVIEWER_PROCESSOR_CAPABILITY_ID,
          codeRabbitProcessor.id,
        );
        await registerReviewSource(ctx.bus, source);
        try {
          await registerReviewerProcessor(ctx.bus, codeRabbitProcessor);
        } catch (error) {
          const rollbacks: Array<Promise<void>> = [];
          if (!hadProcessor) rollbacks.push(unregisterReviewerProcessor(ctx.bus, codeRabbitProcessor.id));
          if (!hadSource) rollbacks.push(unregisterReviewSource(ctx.bus, source.id));
          await Promise.allSettled(rollbacks);
          throw error;
        }
      },
      async destroy() {
        const results = await Promise.allSettled([
          unregisterReviewerProcessor(ctx.bus, codeRabbitProcessor.id),
          unregisterReviewSource(ctx.bus, source.id),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, '[coderabbit] Failed to unregister review capabilities');
        }
      },
    };
  },

  automationTriggers: {
    createAutomationTriggers: (ctx) => [createCodeRabbitReviewPostedTrigger(ctx.bus)],
  },
};

export default coderabbitPackage;

/**
 * Checks whether a capability provider ID already exists before this extension
 * lifecycle attempts to register it.
 * @param bus - Bus used to query the capability registry.
 * @param capabilityId - Capability bucket to inspect.
 * @param providerId - Provider ID to look for.
 * @returns Whether the capability registry currently lists the provider.
 */
async function hasRegisteredCapabilityProvider(
  bus: IMakaioBus,
  capabilityId: string,
  providerId: string,
): Promise<boolean> {
  const result = await bus.requestOptional(CapabilitySubjects.listProviders, { capabilityId });
  if (!result.handled) return false;
  return result.data.providers.some((provider) => provider.id === providerId);
}

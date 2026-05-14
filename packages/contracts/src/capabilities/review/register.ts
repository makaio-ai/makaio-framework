import type { MakaioBusLike } from '@makaio/core';
import { CapabilitySubjects } from '../../capability/index.js';
import type { IReviewSource, IReviewerProcessor } from './types.js';

/**
 * Capability identifier for review sources.
 */
export const REVIEW_SOURCE_CAPABILITY_ID = 'review-source';

/**
 * Capability identifier for reviewer processors.
 */
export const REVIEWER_PROCESSOR_CAPABILITY_ID = 'reviewer-processor';

/**
 * Register a review source with the capability bus.
 * @param bus - The Makaio bus instance
 * @param source - The review source instance to register
 * @returns Promise that resolves after registration handlers have completed
 */
export function registerReviewSource(bus: MakaioBusLike, source: IReviewSource): Promise<void> {
  return bus.emit(CapabilitySubjects.register, {
    capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
    provider: source,
  });
}

/**
 * Unregister a review source from the capability bus.
 * @param bus - The Makaio bus instance
 * @param providerId - Review source provider ID to unregister
 * @returns Promise that resolves after unregistration handlers have completed
 */
export function unregisterReviewSource(bus: MakaioBusLike, providerId: string): Promise<void> {
  return bus.emit(CapabilitySubjects.unregister, {
    capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
    providerId,
  });
}

/**
 * Register a reviewer processor with the capability bus.
 * @param bus - The Makaio bus instance
 * @param processor - The reviewer processor instance to register
 * @returns Promise that resolves after registration handlers have completed
 */
export function registerReviewerProcessor(bus: MakaioBusLike, processor: IReviewerProcessor): Promise<void> {
  return bus.emit(CapabilitySubjects.register, {
    capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
    provider: processor,
  });
}

/**
 * Unregister a reviewer processor from the capability bus.
 * @param bus - The Makaio bus instance
 * @param providerId - Reviewer processor provider ID to unregister
 * @returns Promise that resolves after unregistration handlers have completed
 */
export function unregisterReviewerProcessor(bus: MakaioBusLike, providerId: string): Promise<void> {
  return bus.emit(CapabilitySubjects.unregister, {
    capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
    providerId,
  });
}

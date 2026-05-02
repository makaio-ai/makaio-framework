import { MakaioBus } from '@makaio/bus-core';
import { ReviewSchemas } from './schemas.js';

/**
 * Review namespace for MakaioBus.
 *
 * Registers the review capability subjects with the bus for type-safe
 * request/response handling.
 * @example
 * ```typescript
 * import { ReviewSubjects } from '@makaio/contracts';
 *
 * // Trigger a review
 * const result = await ReviewSubjects.start({ target, repoPath });
 *
 * // List findings
 * const { findings } = await ReviewSubjects['findings.list']({ target });
 * ```
 */
export const ReviewNamespace = MakaioBus.registerNamespace('review', ReviewSchemas);

/**
 * Type-safe subjects for review operations.
 *
 * Provides strongly-typed request/response handlers for each review subject.
 */
export const ReviewSubjects = ReviewNamespace.subjects;

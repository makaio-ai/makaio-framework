import { createBusNamespace } from '@makaio/core';
import { ReviewSchemas } from './schemas.js';

/**
 * Review namespace for MakaioBus.
 *
 * Defines review capability subjects for explicit registration by composition
 * roots.
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
export const ReviewNamespace = createBusNamespace('review', ReviewSchemas);

/**
 * Type-safe subjects for review operations.
 *
 * Provides strongly-typed request/response handlers for each review subject.
 */
export const ReviewSubjects = ReviewNamespace.subjects;

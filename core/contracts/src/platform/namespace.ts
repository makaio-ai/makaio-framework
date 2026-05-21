import { createBusNamespace } from '@makaio/core';
import { PlatformSchemas } from './schemas.js';

/**
 * Platform capability namespace.
 *
 * Cross-platform bus subjects for OS-level capabilities.
 * Each platform package registers handlers for its supported capabilities.
 */
export const PlatformNamespace = createBusNamespace('platform', PlatformSchemas);

/** Type-safe subjects for platform capability operations. */
export const PlatformSubjects = PlatformNamespace.subjects;

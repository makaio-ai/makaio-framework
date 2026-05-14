import { createBusNamespace } from '@makaio/core';
import { RuntimeSchemas } from './schemas.js';

/**
 * Runtime namespace for bus operations.
 *
 * Provides typed subjects for querying runtime-specific resources.
 * Registered globally so lifecycle files can import subjects.
 */
export const RuntimeNamespace = createBusNamespace('runtime', RuntimeSchemas);

/**
 * Runtime subjects for type-safe bus operations.
 *
 * Subjects:
 * - database: Query for Drizzle database handle
 * - machineIdentity: Query for machine identity
 * - busPort: Query for the bus server WebSocket port
 */
export const RuntimeSubjects = RuntimeNamespace.subjects;

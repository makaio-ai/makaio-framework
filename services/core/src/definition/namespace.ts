/**
 * Definition namespace definition.
 *
 * Provides bus subjects for querying JSON Schema descriptions of a
 * provider definition's non-secret config fields. The definition ID
 * (`definitionId`) is the stable string identifier contributed by each
 * provider adapter package (e.g. `'openai'`).
 *
 * Prefix: `definition.`
 *
 * Import `./schemas` when only pure Zod schemas are needed. Composition roots
 * register this namespace explicitly.
 * @example
 * ```typescript
 * // Get the config JSON Schema for a definition
 * const { hasSchema, schema } = await bus.request(
 *   DefinitionSubjects.getConfigSchema,
 *   { definitionId: 'openai' },
 * );
 * ```
 * @packageDocumentation
 */

import { createBusNamespace } from '@makaio/core';
import { DefinitionSchemas } from './schemas.js';

/** Provider definition introspection namespace under the `definition` prefix. */
export const DefinitionNamespace = createBusNamespace('definition', DefinitionSchemas);

/** Pre-extracted definition bus subjects for direct import. */
export const DefinitionSubjects = DefinitionNamespace.subjects;

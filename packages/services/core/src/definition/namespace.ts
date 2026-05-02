/**
 * Definition namespace registration — has side effects (registers on the bus).
 *
 * Provides bus subjects for querying JSON Schema descriptions of a
 * provider definition's config and credential fields.  The definition ID
 * (`definitionId`) is the stable string identifier contributed by each
 * provider adapter package (e.g. `'openai'`).
 *
 * Prefix: `definition.`
 *
 * For pure Zod schemas without side effects, import `./schemas` instead.
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

import { MakaioBus } from '@makaio/bus-core';
import { DefinitionSchemas } from './schemas.js';

/** Provider definition introspection namespace registered under the `definition` prefix. */
export const DefinitionNamespace = MakaioBus.registerNamespace('definition', DefinitionSchemas);

/** Pre-extracted definition bus subjects for direct import. */
export const DefinitionSubjects = DefinitionNamespace.subjects;

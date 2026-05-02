/**
 * Definition namespace bus schemas — pure Zod, no side effects.
 *
 * Provides Zod schemas for querying JSON Schema descriptions of a
 * provider definition's config and credential fields. Import this module
 * when you only need types or validation shapes without registering the
 * namespace on the bus.
 *
 * To register the namespace locally, import `./namespace` instead. Package
 * consumers can use `@makaio/services-core/definition/namespace`.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Permissive JSON Schema type.
 *
 * Matches the `PersonaSchemas.getSchema` pattern — a nullable record of
 * string keys to unknown values, mirroring the shape produced by Zod's
 * `toJsonSchema` helper.
 */
export const JsonSchemaSchema = z.record(z.string(), z.unknown()).nullable();

/**
 * Zod schemas for all definition bus subjects.
 *
 * Each entry becomes a subject identifier as `definition.<key>`.
 */
export const DefinitionSchemas = {
  /** Get the JSON Schema for a provider definition's config fields. */
  getConfigSchema: {
    request: z.object({
      /** Stable provider definition identifier (e.g. `'openai'`). */
      definitionId: z.string(),
    }),
    response: z.object({
      /** `true` when the definition exposes a config schema. */
      hasSchema: z.boolean(),
      /** JSON Schema object, or `null` when none is available. */
      schema: JsonSchemaSchema,
    }),
  },
  /** Get the JSON Schema for a provider definition's credential fields. */
  getCredentialSchema: {
    request: z.object({
      /** Stable provider definition identifier (e.g. `'openai'`). */
      definitionId: z.string(),
    }),
    response: z.object({
      /** `true` when the definition exposes a credential schema. */
      hasSchema: z.boolean(),
      /** JSON Schema object, or `null` when none is available. */
      schema: JsonSchemaSchema,
    }),
  },
} satisfies SchemaRecord;

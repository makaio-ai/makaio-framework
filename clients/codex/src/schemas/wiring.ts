/**
 * Codex wiring management schemas.
 *
 * Defines request/response schema pairs for the `wiring.*` subjects in the
 * Codex client namespace. These schemas are spread into the Codex
 * {@link createClientNamespace} call alongside {@link CodexConfigSchemas}.
 *
 * **Subjects:**
 * - `wiring.list`   — list all known wiring entries with installation status
 * - `wiring.apply`  — install all wiring entries into the target scope
 * - `wiring.remove` — uninstall all wiring entries from the target scope
 * @packageDocumentation
 */

import type { SchemaRecord } from '@makaio/core';
import { z } from 'zod';

import {
  ClientWiringApplyResponseSchema,
  ClientWiringListResponseSchema,
  ClientWiringRemoveResponseSchema,
} from '@makaio/clients-core';

import { AbsolutePathSchema, CodexScopeSchema } from './config.js';

/**
 * Schema record for Codex wiring management subjects.
 *
 * Pass this record (spread) as part of the `additionalSchemas` argument to
 * {@link createClientNamespace} to register these request/response subjects
 * in the `client:codex.*` namespace.
 *
 * Keys use dotted notation matching the bus subject naming convention:
 * - `wiring.list`
 * - `wiring.apply`
 * - `wiring.remove`
 * @example
 * ```typescript
 * import { createClientNamespace } from '@makaio/clients-core';
 * import { CodexConfigSchemas } from './schemas/config.js';
 * import { CodexWiringSchemas } from './schemas/wiring.js';
 *
 * const { subjects } = createClientNamespace('codex', {
 *   ...CodexConfigSchemas,
 *   ...CodexWiringSchemas,
 * });
 * // subjects.wiring.list → 'client:codex.wiring.list'
 * ```
 */
export const CodexWiringSchemas = {
  /**
   * List all known wiring entries for the target scope, indicating which are
   * currently installed in the Codex native config.
   *
   * When `projectDir` is absent, only the `global` scope entries are reported.
   * Callers that need project-scope entries must supply the absolute path to
   * the project root.
   */
  'wiring.list': {
    request: z.object({
      /**
       * Absolute path of the project directory used to locate project-scope
       * config files. When absent, only the global scope is consulted.
       */
      projectDir: AbsolutePathSchema.optional(),
      /**
       * Makaio shell command to use when building the expected command strings
       * in the response entries.
       */
      makaioCommand: z.string().min(1),
    }),
    response: ClientWiringListResponseSchema,
  },

  /**
   * Install all wiring entries into the specified scope.
   *
   * Entries already present are skipped (idempotent). The `makaioCommand`
   * string is written verbatim as the shell command for hook entries.
   */
  'wiring.apply': {
    request: z
      .object({
        /** Scope at which to install the wiring entries. */
        scope: CodexScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'`; ignored for `'global'`.
         */
        projectDir: AbsolutePathSchema.optional(),
        /**
         * Makaio shell command to write into the native config. Must be
         * non-empty.
         */
        makaioCommand: z.string().min(1),
      })
      .refine((data) => data.scope === 'global' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project',
        path: ['projectDir'],
      }),
    response: ClientWiringApplyResponseSchema,
  },

  /**
   * Uninstall all wiring entries from the specified scope.
   *
   * Entries that are not present are silently ignored (idempotent). The
   * `removed` count in the response reflects only entries that were actually
   * deleted from the config file.
   */
  'wiring.remove': {
    request: z
      .object({
        /** Scope from which to remove wiring entries. */
        scope: CodexScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'`; ignored for `'global'`.
         */
        projectDir: AbsolutePathSchema.optional(),
      })
      .refine((data) => data.scope === 'global' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project',
        path: ['projectDir'],
      }),
    response: ClientWiringRemoveResponseSchema,
  },
} satisfies SchemaRecord;

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

/** Inferred type for `wiring.list` request. */
export type CodexWiringListRequest = z.infer<(typeof CodexWiringSchemas)['wiring.list']['request']>;

/** Inferred type for `wiring.apply` request. */
export type CodexWiringApplyRequest = z.infer<(typeof CodexWiringSchemas)['wiring.apply']['request']>;

/** Inferred type for `wiring.remove` request. */
export type CodexWiringRemoveRequest = z.infer<(typeof CodexWiringSchemas)['wiring.remove']['request']>;

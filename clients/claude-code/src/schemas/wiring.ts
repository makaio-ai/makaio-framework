/**
 * Claude Code wiring management schemas.
 *
 * Defines request/response schema pairs for the `wiring.*` subjects in the
 * Claude Code client namespace. These schemas are registered on the
 * `client:claude-code` namespace alongside {@link ClaudeCodeConfigSchemas}.
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

import { AbsolutePathSchema, ClaudeCodeScopeSchema } from './config.js';

/**
 * Bus schema definitions for the `wiring.*` subject namespace.
 *
 * Defines request/response pairs for all wiring management subjects exposed by
 * the Claude Code client. Registered on the `client:claude-code` namespace
 * alongside config schemas via {@link ClaudeCodeConfigSchemas}.
 *
 * Subjects:
 * - `wiring.list`   — list all known wiring entries with installation status
 * - `wiring.apply`  — install all wiring entries into the target scope
 * - `wiring.remove` — uninstall all wiring entries from the target scope
 */
export const ClaudeCodeWiringSchemas = {
  /**
   * List all known wiring entries for the target scope, indicating which are
   * currently installed in the Claude Code native config.
   *
   * When `projectDir` is absent, only the `user` scope entries are reported.
   * Callers that need project- or local-scope entries must supply the absolute
   * path to the project root.
   */
  'wiring.list': {
    request: z.object({
      /**
       * Absolute path of the project directory used to locate project- and
       * local-scope config files. When absent, only the user scope is
       * consulted.
       */
      projectDir: AbsolutePathSchema.optional(),
      /**
       * Makaio shell command to use when building the expected command strings
       * in the response entries.
       */
      makaioCommand: z.string().min(1),
      /**
       * Optional `KEY=value` pairs prepended before the executable in every
       * generated command string. Used in dev mode to inject runtime config
       * env vars that the hook subprocess needs.
       */
      envPairs: z.array(z.string()).optional(),
    }),
    response: ClientWiringListResponseSchema,
  },

  /**
   * Install all wiring entries into the specified scope.
   *
   * Entries already present are skipped (idempotent). The `makaioCommand`
   * string is written verbatim as the shell command for hooks and as the
   * status-line command for the statusline entry.
   */
  'wiring.apply': {
    request: z
      .object({
        /** Scope at which to install the wiring entries. */
        scope: ClaudeCodeScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'` or `'local'`; ignored for `'user'`.
         */
        projectDir: AbsolutePathSchema.optional(),
        /**
         * Makaio shell command to write into the native config. Must be
         * non-empty.
         */
        makaioCommand: z.string().min(1),
        /**
         * Optional `KEY=value` pairs prepended before the executable in every
         * generated command string. Used in dev mode to inject runtime config
         * env vars that the hook subprocess needs.
         */
        envPairs: z.array(z.string()).optional(),
        /**
         * Session-scoped config directory override. When provided, user-scope
         * settings are written here instead of the globally-resolved config path.
         */
        configDir: AbsolutePathSchema.optional(),
      })
      .refine((data) => data.scope === 'user' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project or local',
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
        scope: ClaudeCodeScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'` or `'local'`; ignored for `'user'`.
         */
        projectDir: AbsolutePathSchema.optional(),
      })
      .refine((data) => data.scope === 'user' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project or local',
        path: ['projectDir'],
      }),
    response: ClientWiringRemoveResponseSchema,
  },
} satisfies SchemaRecord;

// ---------------------------------------------------------------------------
// Inferred request types
// ---------------------------------------------------------------------------

/** Inferred type for `wiring.list` request. */
export type ClaudeCodeWiringListRequest = z.infer<(typeof ClaudeCodeWiringSchemas)['wiring.list']['request']>;

/** Inferred type for `wiring.apply` request. */
export type ClaudeCodeWiringApplyRequest = z.infer<(typeof ClaudeCodeWiringSchemas)['wiring.apply']['request']>;

/** Inferred type for `wiring.remove` request. */
export type ClaudeCodeWiringRemoveRequest = z.infer<(typeof ClaudeCodeWiringSchemas)['wiring.remove']['request']>;

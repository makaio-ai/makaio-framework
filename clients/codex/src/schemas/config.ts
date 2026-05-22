/**
 * Codex config management schemas.
 *
 * Defines request/response schema pairs for the `config.hooks.*` subjects in
 * the Codex client namespace. Public request and response payloads expose a
 * flat command-hook view, while `CodexNativeHooksFileSchema` models Codex's
 * nested on-disk `hooks.json` structure for lossless runtime I/O.
 *
 * **Subjects:**
 * - `config.hooks.list` — list effective hooks for a project directory
 * - `config.hooks.add` — add a new hook entry to a scope's config
 * - `config.hooks.remove` — remove hook entries matching a command pattern
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { AbsolutePathSchema } from '@makaio/subsystem-client';

export { AbsolutePathSchema };

/**
 * Scope enum for Codex hook configuration.
 *
 * - `global` — applies to all Codex sessions regardless of project directory
 * - `project` — scoped to a specific project directory
 */
export const CodexScopeSchema = z.enum(['global', 'project']);

/**
 * Inferred TypeScript type for {@link CodexScopeSchema}.
 */
export type CodexScope = z.infer<typeof CodexScopeSchema>;

/**
 * A single command hook entry in the public config-management API.
 *
 * Codex stores command hooks under `hooks[event][].hooks[]` on disk. The bus
 * API flattens that native shape into `{ event, matcher?, command, timeout? }`
 * so callers can manage hooks without duplicating file-format details.
 */
export const CodexHookEntrySchema = z.object({
  /**
   * The hook event name that triggers this hook (e.g. `SessionStart`,
   * `PreToolUse`).
   */
  event: z.string(),
  /**
   * Optional glob pattern to restrict which tool names trigger the hook.
   * Absent means the hook applies to all tools for the given event.
   */
  matcher: z.string().optional(),
  /**
   * Shell command to execute when the hook fires.
   */
  command: z.string(),
  /**
   * Optional timeout in seconds for the hook command.
   * Absent means no timeout override (the Codex CLI default applies).
   */
  timeout: z.number().optional(),
});

/**
 * Inferred TypeScript type for {@link CodexHookEntrySchema}.
 */
export type CodexHookEntry = z.infer<typeof CodexHookEntrySchema>;

/**
 * Native Codex command hook handler as stored inside a matcher group.
 */
export const CodexNativeCommandHookSchema = z
  .object({
    /** Codex hook handler type. */
    type: z.literal('command'),
    /** Shell command to execute when the hook fires. */
    command: z.string(),
    /** Optional UI status message shown while the hook runs. */
    statusMessage: z.string().optional(),
    /** Optional timeout in seconds. */
    timeout: z.number().optional(),
    /** Alternate timeout spelling accepted by Codex. */
    timeoutSec: z.number().optional(),
  })
  .passthrough();

/**
 * Inferred TypeScript type for {@link CodexNativeCommandHookSchema}.
 */
export type CodexNativeCommandHook = z.infer<typeof CodexNativeCommandHookSchema>;

/**
 * Native Codex matcher group as stored under a hook event key.
 */
export const CodexNativeHookMatcherGroupSchema = z
  .object({
    /**
     * Optional regex matcher. `undefined`, `""`, and `"*"` are all handled by
     * Codex as broad matches depending on event support.
     */
    matcher: z.string().optional(),
    /** Hook handlers to run when the matcher group applies. */
    hooks: z.array(z.unknown()),
  })
  .passthrough();

/**
 * Inferred TypeScript type for {@link CodexNativeHookMatcherGroupSchema}.
 */
export type CodexNativeHookMatcherGroup = z.infer<typeof CodexNativeHookMatcherGroupSchema>;

/**
 * Native Codex `hooks.json` file shape.
 *
 * Top-level and nested objects are passthrough so runtime writes preserve
 * fields introduced by newer Codex versions instead of stripping them.
 */
export const CodexNativeHooksFileSchema = z
  .object({
    hooks: z.record(z.string(), z.array(CodexNativeHookMatcherGroupSchema)).optional(),
  })
  .passthrough();

/**
 * Inferred TypeScript type for {@link CodexNativeHooksFileSchema}.
 */
export type CodexNativeHooksFile = z.infer<typeof CodexNativeHooksFileSchema>;

/**
 * Per-scope hook configuration record returned by `config.hooks.list`.
 *
 * Describes all hooks registered at a single config scope together with
 * the path to the backing config file and whether it can be written.
 */
export const CodexScopeHookRecordSchema = z.object({
  /**
   * Config scope this record belongs to.
   */
  scope: CodexScopeSchema,
  /**
   * Absolute path to the config file backing this scope.
   */
  path: z.string(),
  /**
   * Whether the backing config file can be written by the current process.
   */
  writable: z.boolean(),
  /**
   * All hooks registered at this scope.
   */
  hooks: z.array(CodexHookEntrySchema),
});

/**
 * Inferred TypeScript type for {@link CodexScopeHookRecordSchema}.
 */
export type CodexScopeHookRecord = z.infer<typeof CodexScopeHookRecordSchema>;

// ---------------------------------------------------------------------------
// config.hooks.list
// ---------------------------------------------------------------------------

/**
 * Request schema for `config.hooks.list`.
 *
 * Returns the effective hook configuration for the given project directory,
 * optionally filtered to a specific event name.
 */
export const CodexConfigHooksListRequestSchema = z.object({
  /**
   * Optional absolute path to the project directory.
   * When absent, only the global scope is included — project-scoped hooks
   * are omitted from both `effective` and `perScope`.
   */
  projectDir: AbsolutePathSchema.optional(),
  /**
   * Optional event name to filter hooks by (e.g. `PreToolUse`).
   * When absent all event hooks are returned.
   */
  eventName: z.string().optional(),
});

/**
 * Response schema for `config.hooks.list`.
 *
 * Returns the merged effective hook list alongside the per-scope breakdown so
 * consumers can determine which config file contributes each hook.
 */
export const CodexConfigHooksListResponseSchema = z.object({
  /**
   * Effective merged hook list after applying scope precedence rules.
   * This is the set of hooks that actually fire for a Codex session
   * targeting the given project directory.
   */
  effective: z.array(CodexHookEntrySchema),
  /**
   * Per-scope breakdown of hook configuration, ordered from lowest precedence
   * (global) to highest (project). Each entry includes the backing file path
   * and writability flag.
   */
  perScope: z.array(CodexScopeHookRecordSchema),
});

// ---------------------------------------------------------------------------
// config.hooks.add
// ---------------------------------------------------------------------------

/**
 * Request schema for `config.hooks.add`.
 *
 * Adds a new hook entry to the specified scope's configuration.
 * The hook entry fields (`event`, `matcher`, `command`, `timeout`) are
 * composed via {@link CodexHookEntrySchema} so any change to the hook shape
 * propagates here automatically.
 */
export const CodexConfigHooksAddRequestSchema = z
  .object({
    /**
     * Optional absolute path to the project directory.
     * Required when `scope` is `project` so the correct project config file
     * can be located.
     */
    projectDir: AbsolutePathSchema.optional(),
    /**
     * Config scope to write the hook into.
     */
    scope: CodexScopeSchema,
  })
  .merge(CodexHookEntrySchema)
  .refine((data) => data.scope === 'global' || data.projectDir !== undefined, {
    message: 'projectDir is required when scope is project',
    path: ['projectDir'],
  });

/**
 * Response schema for `config.hooks.add`.
 */
export const CodexConfigHooksAddResponseSchema = z.object({
  /**
   * Whether the hook entry was successfully written to the config file.
   */
  added: z.boolean(),
});

// ---------------------------------------------------------------------------
// config.hooks.remove
// ---------------------------------------------------------------------------

/**
 * Request schema for `config.hooks.remove`.
 *
 * Removes hook entries from the specified scope's configuration that match
 * both the `event` and the command substring filter.
 */
export const CodexConfigHooksRemoveRequestSchema = z
  .object({
    /**
     * Optional absolute path to the project directory.
     * Required when `scope` is `project`.
     */
    projectDir: AbsolutePathSchema.optional(),
    /**
     * Config scope from which to remove matching hooks.
     */
    scope: CodexScopeSchema,
    /**
     * Event name to match against when selecting hooks for removal.
     */
    event: z.string(),
    /**
     * Filter criteria selecting which hooks to remove.
     * All hooks whose `command` field contains {@link commandContains} as a
     * substring are removed.
     */
    match: z.object({
      /**
       * Substring that must appear in the hook command for removal.
       */
      commandContains: z.string(),
    }),
  })
  .refine((data) => data.scope === 'global' || data.projectDir !== undefined, {
    message: 'projectDir is required when scope is project',
    path: ['projectDir'],
  });

/**
 * Response schema for `config.hooks.remove`.
 */
export const CodexConfigHooksRemoveResponseSchema = z.object({
  /**
   * Number of hook entries removed from the config file.
   */
  removed: z.number(),
});

// ---------------------------------------------------------------------------
// Inferred types for request/response pairs
// ---------------------------------------------------------------------------

/** Inferred type for `config.hooks.list` request. */
export type CodexConfigHooksListRequest = z.infer<typeof CodexConfigHooksListRequestSchema>;

/** Inferred type for `config.hooks.list` response. */
export type CodexConfigHooksListResponse = z.infer<typeof CodexConfigHooksListResponseSchema>;

/** Inferred type for `config.hooks.add` request. */
export type CodexConfigHooksAddRequest = z.infer<typeof CodexConfigHooksAddRequestSchema>;

/** Inferred type for `config.hooks.add` response. */
export type CodexConfigHooksAddResponse = z.infer<typeof CodexConfigHooksAddResponseSchema>;

/** Inferred type for `config.hooks.remove` request. */
export type CodexConfigHooksRemoveRequest = z.infer<typeof CodexConfigHooksRemoveRequestSchema>;

/** Inferred type for `config.hooks.remove` response. */
export type CodexConfigHooksRemoveResponse = z.infer<typeof CodexConfigHooksRemoveResponseSchema>;

// ---------------------------------------------------------------------------
// Composed schema record for createClientNamespace(additionalSchemas)
// ---------------------------------------------------------------------------

/**
 * Schema record for Codex config management subjects.
 *
 * Pass this record as the `additionalSchemas` argument to
 * {@link createClientNamespace} to register these request/response subjects
 * in the `client:codex.*` namespace.
 *
 * Keys use dotted notation matching the bus subject naming convention:
 * - `config.hooks.list`
 * - `config.hooks.add`
 * - `config.hooks.remove`
 * @example
 * ```typescript
 * import { createClientNamespace } from '@makaio/subsystem-client';
 * import { CodexConfigSchemas } from './schemas/index.js';
 *
 * const { subjects } = createClientNamespace('codex', CodexConfigSchemas);
 * // subjects.config.hooks.list → 'client:codex.config.hooks.list'
 * ```
 */
export const CodexConfigSchemas = {
  /**
   * List effective hook configuration for a project directory.
   *
   * Merges global and project-scoped hooks and returns both the effective list
   * and the per-scope breakdown.
   */
  'config.hooks.list': {
    request: CodexConfigHooksListRequestSchema,
    response: CodexConfigHooksListResponseSchema,
  },

  /**
   * Add a new hook entry to a config scope.
   */
  'config.hooks.add': {
    request: CodexConfigHooksAddRequestSchema,
    response: CodexConfigHooksAddResponseSchema,
  },

  /**
   * Remove hook entries matching an event and command substring from a scope.
   */
  'config.hooks.remove': {
    request: CodexConfigHooksRemoveRequestSchema,
    response: CodexConfigHooksRemoveResponseSchema,
  },
} satisfies SchemaRecord;

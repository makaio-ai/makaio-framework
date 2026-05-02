import type { SchemaRecord } from '@makaio/core';
import { z } from 'zod';
import { AbsolutePathSchema } from '@makaio/clients-core';

/**
 * Scope at which a Claude Code configuration entry is written or read.
 *
 * Three tiers of Claude Code configuration scope:
 * - `user`    — stored in the user-global Claude config (e.g. `~/.claude/settings.json`)
 * - `project` — stored in the project-shared dotfile (e.g. `.claude/settings.json`)
 * - `local`   — stored in the local-only project dotfile (e.g. `.claude/settings.local.json`)
 *
 * The `managed` scope present in the full Claude Code spec is intentionally
 * omitted in v1.
 */
export const ClaudeCodeScopeSchema = z.enum(['user', 'project', 'local']);

export type ClaudeCodeScope = z.infer<typeof ClaudeCodeScopeSchema>;

export { AbsolutePathSchema };

/**
 * A Claude Code status-line command definition.
 *
 * Matches the native Claude Code settings shape for a custom status-line
 * entry. The `type` discriminant is always `'command'` in v1.
 */
export const ClaudeCodeStatuslineValueSchema = z.object({
  /**
   * Discriminant — always `'command'` for external command-based status lines.
   */
  type: z.literal('command'),
  /**
   * Shell command Claude Code invokes to produce the status-line text.
   */
  command: z.string().min(1),
  /**
   * Optional column padding applied around the rendered output.
   */
  padding: z.number().optional(),
});

export type ClaudeCodeStatuslineValue = z.infer<typeof ClaudeCodeStatuslineValueSchema>;

/**
 * A single Claude Code hook command definition.
 *
 * Matches the native Claude Code settings shape for a hook entry. The `type`
 * discriminant is always `'command'` in v1.
 */
export const ClaudeCodeHookDefinitionSchema = z.object({
  /**
   * Discriminant — always `'command'` for shell-command hooks.
   */
  type: z.literal('command'),
  /**
   * Shell command Claude Code executes when the hook fires.
   */
  command: z.string().min(1),
  /**
   * Optional timeout in milliseconds before the hook process is killed.
   */
  timeout: z.number().optional(),
});

export type ClaudeCodeHookDefinition = z.infer<typeof ClaudeCodeHookDefinitionSchema>;

/**
 * A Claude Code hook matcher group.
 *
 * Groups one or more hook definitions under an optional glob-style matcher.
 * When `matcher` is absent the hooks apply to all tool invocations for the
 * parent event.
 */
export const ClaudeCodeHookMatcherGroupSchema = z.object({
  /**
   * Optional glob pattern selecting which tool calls or paths trigger this
   * group of hooks.
   */
  matcher: z.string().optional(),
  /**
   * Hook definitions to execute when the matcher (if any) is satisfied.
   */
  hooks: z.array(ClaudeCodeHookDefinitionSchema),
});

export type ClaudeCodeHookMatcherGroup = z.infer<typeof ClaudeCodeHookMatcherGroupSchema>;

// ---------------------------------------------------------------------------
// Per-scope entry schemas
// ---------------------------------------------------------------------------

/**
 * Per-scope entry returned when listing a scoped config value.
 *
 * Each entry carries the resolved scope identifier, the on-disk path of the
 * settings file consulted, and the value found at that scope (or `null` when
 * the scope has no entry).
 */
export const ClaudeCodeStatuslinePerScopeEntrySchema = z.object({
  /** Scope this entry was read from. */
  scope: ClaudeCodeScopeSchema,
  /** Absolute path of the settings file for this scope. */
  path: z.string(),
  /** Status-line value at this scope, or `null` if unset. */
  value: ClaudeCodeStatuslineValueSchema.nullable(),
});

export type ClaudeCodeStatuslinePerScopeEntry = z.infer<typeof ClaudeCodeStatuslinePerScopeEntrySchema>;

/**
 * Per-scope hooks entry returned when listing hook configuration.
 *
 * Carries the scope identifier, its settings file path, and the full map of
 * event-name → matcher groups recorded at that scope.
 */
export const ClaudeCodeHooksPerScopeEntrySchema = z.object({
  /** Scope this entry was read from. */
  scope: ClaudeCodeScopeSchema,
  /** Absolute path of the settings file for this scope. */
  path: z.string(),
  /**
   * Hooks declared at this scope, keyed by Claude Code event name (e.g.
   * `"PreToolUse"`, `"PostToolUse"`).
   */
  events: z.record(z.string(), z.array(ClaudeCodeHookMatcherGroupSchema)),
});

export type ClaudeCodeHooksPerScopeEntry = z.infer<typeof ClaudeCodeHooksPerScopeEntrySchema>;

/** Schema for a single plugin entry in the Claude Code configuration. */
export const ClaudeCodePluginEntrySchema = z.object({
  /** Plugin package name or identifier. */
  name: z.string().min(1),
  /** Whether the plugin is currently enabled. */
  enabled: z.boolean(),
  /** Scope at which this plugin entry is declared. */
  scope: ClaudeCodeScopeSchema,
});

export type ClaudeCodePluginEntry = z.infer<typeof ClaudeCodePluginEntrySchema>;

// ---------------------------------------------------------------------------
// Config schemas record
// ---------------------------------------------------------------------------

/**
 * Bus schema definitions for the `config.*` subject namespace.
 *
 * Defines request/response pairs for all config management subjects exposed by
 * the Claude Code client. Dotted keys are resolved to nested subject accessors
 * by the bus infrastructure.
 *
 * Subjects:
 * - `config.statusline.list`  — read effective + per-scope status-line config
 * - `config.statusline.set`   — write a status-line value at a given scope
 * - `config.hooks.list`       — read effective + per-scope hook config
 * - `config.hooks.add`        — append a hook to a given scope and event
 * - `config.hooks.remove`     — remove hooks matching a command substring
 * - `config.extensions.list`     — list installed extensions with enabled state
 */
export const ClaudeCodeConfigSchemas = {
  /**
   * Read the effective status-line configuration plus each scope's raw value.
   *
   * The `effective` field reflects the value that Claude Code would use after
   * scope resolution. `perScope` enumerates available scopes in resolution
   * order (broadest to narrowest) so callers can inspect the full picture.
   */
  'config.statusline.list': {
    request: z.object({
      /**
       * Absolute path of the project directory used to locate the project-
       * and local-scope settings files. When absent, only the user scope is
       * consulted — this is intentional for read-only list subjects where
       * the caller may not have a project context.
       */
      projectDir: AbsolutePathSchema.optional(),
    }),
    response: z.object({
      /**
       * The resolved status-line value after scope priority, or `null` when no
       * scope defines one.
       */
      effective: ClaudeCodeStatuslineValueSchema.nullable(),
      /**
       * Per-scope breakdown in resolution order (broadest to narrowest).
       */
      perScope: z.array(ClaudeCodeStatuslinePerScopeEntrySchema),
    }),
  },

  /**
   * Write a status-line value to a specific scope.
   *
   * Overwrites any existing status-line entry at the chosen scope and returns
   * both the previous value (for undo support) and the value that was actually
   * persisted.
   */
  'config.statusline.set': {
    request: z
      .object({
        /** Scope at which to write the new status-line entry. */
        scope: ClaudeCodeScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'` or `'local'`; ignored for `'user'`.
         */
        projectDir: AbsolutePathSchema.optional(),
        /** New status-line command to persist. */
        value: ClaudeCodeStatuslineValueSchema,
      })
      .refine((data) => data.scope === 'user' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project or local',
        path: ['projectDir'],
      }),
    response: z.object({
      /**
       * Previous status-line value at that scope, or `null` when the scope had
       * no entry before this write.
       */
      previous: ClaudeCodeStatuslineValueSchema.nullable(),
      /** The value that was written and is now active at this scope. */
      applied: ClaudeCodeStatuslineValueSchema,
    }),
  },

  /**
   * Read the effective hook configuration plus each scope's raw hook map.
   *
   * When `eventName` is supplied only hooks for that event are returned;
   * otherwise all events are included.
   */
  'config.hooks.list': {
    request: z.object({
      /**
       * When provided, filters the response to a single Claude Code event
       * (e.g. `"PreToolUse"`). Not constrained to `.min(1)` because this is
       * a read-only filter hint — empty string harmlessly returns no matches.
       */
      eventName: z.string().optional(),
      /**
       * Absolute path of the project directory used to resolve project- and
       * local-scope settings files.
       */
      projectDir: AbsolutePathSchema.optional(),
    }),
    response: z.object({
      /**
       * Merged hook map after scope resolution, keyed by event name.
       * Each value is the ordered array of matcher groups that would fire.
       */
      effective: z.record(z.string(), z.array(ClaudeCodeHookMatcherGroupSchema)),
      /**
       * Per-scope breakdown so callers can distinguish which scope contributed
       * each hook.
       */
      perScope: z.array(ClaudeCodeHooksPerScopeEntrySchema),
    }),
  },

  /**
   * Append a hook to a given scope, event, and optional matcher.
   *
   * Creates or extends the matcher group at the target scope. If a group with
   * the same `matcher` already exists the hook is appended to it; otherwise a
   * new group is created.
   */
  'config.hooks.add': {
    request: z
      .object({
        /** Scope at which to add the hook. */
        scope: ClaudeCodeScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'` or `'local'`.
         */
        projectDir: AbsolutePathSchema.optional(),
        /**
         * Claude Code event name to attach the hook to (e.g. `"PreToolUse"`).
         */
        eventName: z.string().min(1),
        /**
         * Optional glob matcher that gates when this hook fires. Omit to match
         * all invocations of the event.
         */
        matcher: z.string().min(1).optional(),
        /** Hook command definition to add. */
        hook: ClaudeCodeHookDefinitionSchema,
      })
      .refine((data) => data.scope === 'user' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project or local',
        path: ['projectDir'],
      }),
    response: z.object({
      /**
       * `true` when the hook was successfully written; `false` when an
       * identical entry already existed and no write was needed.
       */
      added: z.boolean(),
    }),
  },

  /**
   * Remove hooks whose command string contains the given substring.
   *
   * Removes every hook definition in the specified scope and event whose
   * `command` field contains `match.commandContains`. Matcher groups that
   * become empty after removal are also pruned.
   */
  'config.hooks.remove': {
    request: z
      .object({
        /** Scope from which to remove hooks. */
        scope: ClaudeCodeScopeSchema,
        /**
         * Absolute path of the project directory. Required when `scope` is
         * `'project'` or `'local'`.
         */
        projectDir: AbsolutePathSchema.optional(),
        /**
         * Claude Code event name whose hooks should be filtered (e.g.
         * `"PostToolUse"`).
         */
        eventName: z.string().min(1),
        /**
         * Criteria for selecting hooks to remove. Currently supports substring
         * matching on the command string.
         */
        match: z.object({
          /** Remove hooks whose `command` field contains this substring. */
          commandContains: z.string().min(1),
        }),
      })
      .refine((data) => data.scope === 'user' || data.projectDir !== undefined, {
        message: 'projectDir is required when scope is project or local',
        path: ['projectDir'],
      }),
    response: z.object({
      /**
       * Number of hook definitions that were actually removed from the settings
       * file.
       */
      removed: z.number(),
    }),
  },

  /**
   * List effective extensions visible to Claude Code along with enabled state.
   *
   * Later scopes override earlier scopes per plugin name; the returned scope is
   * the scope that supplied the effective enabled state.
   */
  'config.plugins.list': {
    request: z.object({
      /**
       * Absolute path of the project directory used to locate project- and
       * local-scope settings files.
       */
      projectDir: AbsolutePathSchema.optional(),
    }),
    response: z.object({
      /** Plugins registered across all visible scopes. */
      plugins: z.array(ClaudeCodePluginEntrySchema),
    }),
  },
} satisfies SchemaRecord;

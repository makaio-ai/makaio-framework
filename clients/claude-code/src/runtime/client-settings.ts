/**
 * Claude Code client settings manager.
 *
 * Provides read/write access to Claude Code's native `settings.json` files
 * across all three settings scopes (`user`, `project`, `local`).  Writes are
 * atomic (write-to-UUID-tmp then rename) and serialised per path via a per-path
 * mutex so concurrent calls to the same file are safe.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';

import { atomicModifyFile } from '@makaio/clients-core';
import type {
  ClaudeCodeScope,
  ClaudeCodeStatuslineValue,
  ClaudeCodeHookDefinition,
  ClaudeCodePluginEntry,
} from '../schemas/config.js';
import { coerceHooksMap, isStatuslineValue } from './client-settings-guards.js';
import { applyHookAddition, applyHookRemoval } from './client-settings-modifiers.js';
import {
  resolveClaudeCodeSettingsPaths,
  type ClaudeCodeSettingsPath,
  type ResolveClaudeCodeSettingsPathsOptions,
} from './settings-paths.js';

export type {
  HookAddResult,
  HookRemoveResult,
  HooksListResult,
  PluginsListResult,
  StatuslineListResult,
  StatuslineRemoveResult,
  StatuslineSetResult,
} from './client-settings-types.js';
import type {
  HookAddResult,
  HookRemoveResult,
  HooksListResult,
  PluginsListResult,
  StatuslineListResult,
  StatuslineRemoveResult,
  StatuslineSetResult,
} from './client-settings-types.js';

// ---------------------------------------------------------------------------
// Module-scoped write mutex
// ---------------------------------------------------------------------------

/**
 * Global per-path write mutex shared across all {@link ClaudeCodeClientSettings}
 * instances.  Module-scoped so that concurrent requests routed to different
 * service-handler instances still serialize writes to the same file.
 */
const writeMutex = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// ClaudeCodeClientSettings
// ---------------------------------------------------------------------------

/**
 * Manages Claude Code's native `settings.json` files for all applicable
 * settings scopes.
 *
 * **Do not use this class as a BaseService.**  It is a plain class intended to
 * be composed inside a service that owns the lifecycle.
 *
 * All writes are:
 * - **Atomic** — written to a UUID-suffixed sibling then renamed into place.
 * - **Serialised** — a module-scoped per-path mutex prevents concurrent writes
 *   to the same file from interleaving, even across instances.
 * - **Lossless** — each write passes a modifier function that receives the
 *   current file contents and returns the updated object, so unrelated keys
 *   are never discarded.
 */
export class ClaudeCodeClientSettings {
  /** Resolved path entries for each settings scope available at construction. */
  private readonly scopePaths: ClaudeCodeSettingsPath[];

  /**
   * Create a new ClaudeCodeClientSettings instance.
   * @param options - Optional path resolution parameters forwarded directly to
   *   {@link resolveClaudeCodeSettingsPaths}.  Pass `{ projectDir }` to
   *   include project/local scopes, `{ configDir }` to redirect the user-scope
   *   settings file to an isolated directory, or both together.  Omitting the
   *   parameter preserves the original `~/.claude/settings.json` behaviour.
   */
  public constructor(options?: ResolveClaudeCodeSettingsPathsOptions) {
    this.scopePaths = resolveClaudeCodeSettingsPaths(options);
  }

  // -------------------------------------------------------------------------
  // Private core infrastructure
  // -------------------------------------------------------------------------

  /**
   * Read and parse the settings JSON file for a given scope.
   *
   * Returns the parsed object, or `null` when the file does not exist.
   * Throws on corrupt JSON, non-object JSON (arrays, numbers, strings), or
   * permission errors — ENOENT is the only error handled gracefully.
   * @param scope - Settings scope to read.
   * @returns Parsed JSON object or `null`.
   */
  private async readScope(scope: ClaudeCodeScope): Promise<Record<string, unknown> | null> {
    const entry = this.requireScopePath(scope);
    try {
      const content = await fs.readFile(entry.path, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        const parsedKind = Array.isArray(parsed) ? 'array' : typeof parsed;
        throw new SyntaxError(`Settings file at '${entry.path}' contains non-object JSON: ${parsedKind}`);
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Apply a modifier to a settings scope and persist the result atomically.
   *
   * The sequence is:
   * 1. Acquire the per-path mutex for the target file.
   * 2. Read the current contents (or `{}` if absent).
   * 3. Pass the current contents to `modifier` and receive the updated object.
   * 4. Create the parent directory (`mkdir -p`).
   * 5. Atomically write the result via a UUID-suffixed temp file and rename.
   * @param scope - Settings scope to modify.
   * @param modifier - Pure function receiving and returning the raw settings
   *   object; return the same reference to skip the write.
   */
  private async modifyScope(
    scope: ClaudeCodeScope,
    modifier: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const entry = this.requireScopePath(scope);
    await atomicModifyFile<Record<string, unknown>, void>(
      entry.path,
      {},
      writeMutex,
      (raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          const kind = Array.isArray(raw) ? 'array' : typeof raw;
          throw new SyntaxError(`Settings file at '${entry.path}' contains non-object JSON: ${kind}`);
        }
        return raw as Record<string, unknown>;
      },
      (current) => {
        const updated = modifier(current);
        return { content: updated, changed: updated !== current, result: undefined };
      },
    );
  }

  /**
   * Resolve the {@link ClaudeCodeSettingsPath} entry for `scope`, throwing if
   * the scope is not available (e.g. `'project'` requested but no `projectDir`
   * was supplied at construction).
   * @param scope - Scope to resolve.
   * @returns The matching path entry.
   */
  private requireScopePath(scope: ClaudeCodeScope): ClaudeCodeSettingsPath {
    const entry = this.scopePaths.find((p) => p.scope === scope);
    if (entry === undefined) {
      throw new Error(`Scope '${scope}' is not available: no projectDir was provided at construction.`);
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // Public API — Statusline
  // -------------------------------------------------------------------------

  /**
   * List the status-line configuration across all available scopes.
   *
   * The `effective` value is determined by last-scope-wins: the narrowest scope
   * (highest index in `perScope`) that has a non-null value wins.
   * @returns Effective status-line value and per-scope breakdown.
   */
  public async listStatusline(): Promise<StatuslineListResult> {
    const perScope = await Promise.all(
      this.scopePaths.map(async (entry) => {
        const raw = await this.readScope(entry.scope);
        const statusLine = raw?.['statusLine'];
        const value = isStatuslineValue(statusLine) ? statusLine : null;
        return { scope: entry.scope, path: entry.path, value };
      }),
    );

    // Last scope wins (highest-priority scope is last in the array)
    let effective: ClaudeCodeStatuslineValue | null = null;
    for (const entry of perScope) {
      if (entry.value !== null) {
        effective = entry.value;
      }
    }

    return { effective, perScope };
  }

  /**
   * Write a status-line value to a specific scope.
   *
   * Only the `statusLine` key is touched; all other keys in the settings file
   * are preserved.
   * @param req - Request specifying the target scope and the value to write.
   * @returns The previous value at the scope (or `null`) and the applied value.
   */
  public async setStatusline(req: {
    scope: ClaudeCodeScope;
    value: ClaudeCodeStatuslineValue;
  }): Promise<StatuslineSetResult> {
    let previous: ClaudeCodeStatuslineValue | null = null;

    await this.modifyScope(req.scope, (current) => {
      previous = isStatuslineValue(current['statusLine']) ? current['statusLine'] : null;
      if (
        previous !== null &&
        previous.type === req.value.type &&
        previous.command === req.value.command &&
        previous.padding === req.value.padding
      ) {
        return current;
      }
      return { ...current, statusLine: req.value };
    });

    return { previous, applied: req.value };
  }

  /**
   * Remove the status-line entry from a specific scope.
   *
   * Only the `statusLine` key is removed; all other keys in the settings file
   * are preserved.  When no status-line entry exists in the scope, the file is
   * not modified and `removed: false` is returned.
   * @param req - Request specifying the target scope to clear.
   * @returns The value that was removed and whether a removal occurred.
   */
  public async removeStatusline(req: { scope: ClaudeCodeScope }): Promise<StatuslineRemoveResult> {
    let previous: ClaudeCodeStatuslineValue | null = null;
    let removed = false;

    await this.modifyScope(req.scope, (current) => {
      const existing = isStatuslineValue(current['statusLine']) ? current['statusLine'] : null;
      if (existing === null) {
        return current;
      }
      previous = existing;
      removed = true;
      const updated = { ...current };
      delete updated['statusLine'];
      return updated;
    });

    return { previous, removed };
  }

  // -------------------------------------------------------------------------
  // Public API — Hooks
  // -------------------------------------------------------------------------

  /**
   * List hooks across all available scopes.
   *
   * The merge strategy is **additive**: every scope's groups are concatenated
   * in resolution order (broadest → narrowest).  If `eventName` is supplied,
   * only that event is included in both `effective` and `perScope`.
   * @param req - Optional `eventName` to filter results.
   * @returns Merged effective hooks and per-scope breakdown.
   */
  public async listHooks(req?: { eventName?: string }): Promise<HooksListResult> {
    const perScope = await Promise.all(
      this.scopePaths.map(async (entry) => {
        const raw = await this.readScope(entry.scope);
        let events = coerceHooksMap(raw?.['hooks']);
        if (req?.eventName !== undefined) {
          const filtered: Record<string, (typeof events)[string]> = {};
          if (events[req.eventName] !== undefined) {
            filtered[req.eventName] = events[req.eventName];
          }
          events = filtered;
        }
        return { scope: entry.scope, path: entry.path, events };
      }),
    );

    // Additive merge: all scopes contribute their groups
    const effective: HooksListResult['effective'] = {};
    for (const entry of perScope) {
      for (const [eventName, groups] of Object.entries(entry.events)) {
        if (effective[eventName] === undefined) {
          effective[eventName] = [];
        }
        effective[eventName].push(...groups);
      }
    }

    return { effective, perScope };
  }

  /**
   * Append a hook to a scope, event, and optional matcher group.
   *
   * If a group with the same `matcher` already exists, the hook is appended to
   * it; otherwise a new group is created.  The operation is idempotent: if an
   * identical hook (same `type`, `command`, and `timeout`) already exists in
   * the group, no write is performed.
   * @param req - Scope, event name, optional matcher, and hook definition.
   * @returns `{ added: true }` when the hook was written; `{ added: false }`
   *   when the identical hook already existed.
   */
  public async addHook(req: {
    scope: ClaudeCodeScope;
    eventName: string;
    matcher?: string;
    hook: ClaudeCodeHookDefinition;
  }): Promise<HookAddResult> {
    let added = false;

    await this.modifyScope(req.scope, (current) => {
      const result = applyHookAddition(current, req);
      added = result.added;
      return result.updated;
    });

    return { added };
  }

  /**
   * Remove hooks whose `command` field contains the given substring.
   *
   * After removal, empty matcher groups (groups with no hooks left) and empty
   * events (events with no groups left) are pruned from the file.  All other
   * keys and events are preserved.
   * @param req - Scope, event name, and substring match criteria.
   * @returns The number of hook definitions that were removed.
   */
  public async removeHook(req: {
    scope: ClaudeCodeScope;
    eventName: string;
    match: { commandContains: string };
  }): Promise<HookRemoveResult> {
    let removed = 0;

    await this.modifyScope(req.scope, (current) => {
      const result = applyHookRemoval(current, req);
      removed = result.removed;
      return result.updated;
    });

    return { removed };
  }

  // -------------------------------------------------------------------------
  // Public API — Plugins
  // -------------------------------------------------------------------------

  /**
   * List the effective extensions visible across all available scopes.
   *
   * Claude Code stores `enabledPlugins` as a `Record<string, boolean>` mapping
   * plugin name to enabled flag.  Later scopes override earlier scopes for the
   * same plugin name, matching Claude Code's settings hierarchy.
   * @returns Effective plugin entries with the winning declaration scope.
   */
  public async listPlugins(): Promise<PluginsListResult> {
    const perScopePlugins = await Promise.all(
      this.scopePaths.map(async (entry) => {
        const raw = await this.readScope(entry.scope);
        const enabledPlugins = raw?.['enabledPlugins'];
        if (typeof enabledPlugins !== 'object' || enabledPlugins === null || Array.isArray(enabledPlugins)) return [];

        const results: ClaudeCodePluginEntry[] = [];
        for (const [name, enabled] of Object.entries(enabledPlugins as Record<string, unknown>)) {
          if (typeof enabled === 'boolean') {
            results.push({ name, enabled, scope: entry.scope });
          }
        }
        return results;
      }),
    );

    const effectivePlugins = new Map<string, ClaudeCodePluginEntry>();
    for (const entries of perScopePlugins) {
      for (const entry of entries) {
        effectivePlugins.set(entry.name, entry);
      }
    }

    return { plugins: Array.from(effectivePlugins.values()) };
  }
}

/**
 * Codex client settings I/O.
 *
 * Provides filesystem read/write operations for Codex `hooks.json`
 * configuration files. Handles both global and project-scoped config files
 * with atomic writes and per-path write serialization to prevent concurrent
 * modification.
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicModifyFile } from '@makaio/clients-core';
import { CodexNativeCommandHookSchema, CodexNativeHooksFileSchema } from '../schemas/config.js';
import type {
  CodexHookEntry,
  CodexScope,
  CodexNativeCommandHook,
  CodexNativeHooksFile,
  CodexConfigHooksListResponse,
  CodexConfigHooksAddResponse,
  CodexConfigHooksRemoveResponse,
} from '../schemas/config.js';
import { resolveCodexSettingsPaths, type CodexSettingsPaths } from './settings-paths.js';

/** Empty native hooks file used as the baseline for missing files. */
const EMPTY_HOOKS_FILE: CodexNativeHooksFile = { hooks: {} };

// ---------------------------------------------------------------------------
// Module-scoped write mutex
// ---------------------------------------------------------------------------

/**
 * Global per-path write mutex shared across all {@link CodexClientSettings}
 * instances. Module-scoped so that concurrent requests routed to different
 * service-handler instances still serialize writes to the same file.
 */
const writeMutex = new Map<string, Promise<void>>();

/**
 * Optional path override injected during testing.
 * When provided, {@link CodexClientSettings} uses these paths instead of
 * calling {@link resolveCodexSettingsPaths}.
 */
export interface CodexClientSettingsPathsOverride {
  /**
   * Absolute path to the global `hooks.json` file.
   */
  readonly globalHooks: string;
  /**
   * Absolute path to the project-scoped `hooks.json` file, or `null`.
   */
  readonly projectHooks: string | null;
}

/**
 * Path resolution options for {@link CodexClientSettings}.
 */
export interface CodexClientSettingsOptions {
  /** Optional managed Codex config root used for global-scope hooks. */
  readonly configDir?: string;
  /** Optional exact path override used by tests. */
  readonly pathsOverride?: CodexClientSettingsPathsOverride;
}

/**
 * Handles reading and writing Codex `hooks.json` configuration files.
 *
 * This is a plain composed component — not a `BaseService` — intended to be
 * instantiated inside `CodexClientSessionService` or a similar host.
 *
 * ## Atomic writes
 * All writes go through a temp-file + `fs.rename()` sequence so that readers
 * never see a partially written file.
 *
 * ## Write serialization
 * A module-scoped per-path mutex ensures that concurrent callers modifying
 * the same file are serialized rather than racing, even across instances.
 */
export class CodexClientSettings {
  /**
   * Optional path override used in tests. When `undefined`, paths are
   * resolved dynamically via {@link resolveCodexSettingsPaths}.
   */
  private readonly pathsOverride: CodexClientSettingsPathsOverride | undefined;
  /** Optional managed Codex config root for global-scope hooks. */
  private readonly configDir: string | undefined;

  /**
   * Creates a new `CodexClientSettings` instance.
   * @param options - Optional path override or config-root options. Passing
   *   `{ globalHooks, projectHooks }` remains supported for existing tests.
   */
  public constructor(options?: CodexClientSettingsPathsOverride | CodexClientSettingsOptions) {
    if (options !== undefined && 'globalHooks' in options) {
      this.pathsOverride = options;
      this.configDir = undefined;
      return;
    }
    this.pathsOverride = options?.pathsOverride;
    this.configDir = options?.configDir;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * List the effective hook configuration for a project directory.
   *
   * Reads both the global and (when available) project-scoped config files,
   * concatenates their hooks into an effective list, and returns the per-scope
   * breakdown alongside it.
   * @param req - Request options. `projectDir` is the optional absolute path to
   *   the project root (when omitted only the global scope is read).
   *   `eventName` is an optional event name filter; when omitted all hooks are
   *   returned.
   * @returns Effective merged hook list and per-scope breakdown.
   */
  public async listHooks(req: { projectDir?: string; eventName?: string }): Promise<CodexConfigHooksListResponse> {
    const paths = this.resolvePaths(req.projectDir);

    const globalPromise = Promise.all([this.readHooksFile(paths.globalHooks), this.isWritable(paths.globalHooks)]);
    const projectPath = paths.projectHooks;

    const [globalHooks, globalWritable] = await globalPromise;
    const perScope: CodexConfigHooksListResponse['perScope'] = [
      { scope: 'global', path: paths.globalHooks, writable: globalWritable, hooks: globalHooks },
    ];

    if (projectPath !== null) {
      const [projectHooks, projectWritable] = await Promise.all([
        this.readHooksFile(projectPath),
        this.isWritable(projectPath),
      ]);
      perScope.push({
        scope: 'project',
        path: projectPath,
        writable: projectWritable,
        hooks: projectHooks,
      });
    }

    let effective: CodexHookEntry[] = perScope.flatMap((record) => record.hooks);

    if (req.eventName !== undefined) {
      effective = effective.filter((entry) => entry.event === req.eventName);
    }

    return { effective, perScope };
  }

  /**
   * Add a new hook entry to the specified config scope.
   *
   * The operation is idempotent: if a hook with the same `event`, `command`,
   * and `matcher` already exists in the target file, the file is left
   * unchanged and `{ added: false }` is returned.
   * @param req - Hook entry and targeting options. `scope` selects the config
   *   file; `projectDir` is required when `scope` is `'project'`. `event`,
   *   `command`, and optional `matcher` / `timeout` form the hook entry.
   * @returns `{ added: true }` when the hook was appended, `{ added: false }`
   *   when an identical hook already exists.
   */
  public async addHook(req: {
    projectDir?: string;
    scope: CodexScope;
    event: string;
    matcher?: string;
    command: string;
    timeout?: number;
  }): Promise<CodexConfigHooksAddResponse> {
    const filePath = this.resolvePathForScope(req.scope, req.projectDir);

    const { result } = await this.modifyHooksFile(filePath, (hooks) => {
      const eventGroups = hooks.hooks?.[req.event] ?? [];
      const duplicate = eventGroups.some((group) => {
        if (group.matcher !== req.matcher) return false;
        return group.hooks.some((handler) => {
          const parseResult = CodexNativeCommandHookSchema.safeParse(handler);
          return parseResult.success && parseResult.data.command === req.command;
        });
      });

      if (duplicate) {
        return { hooks, result: { added: false }, changed: false };
      }

      const entry: CodexNativeCommandHook = {
        type: 'command',
        command: req.command,
        ...(req.timeout !== undefined ? { timeout: req.timeout } : {}),
      };

      // Matcher identity uses strict equality — this layer does not normalize
      // "", "*", and undefined into a single "no matcher" value because the
      // caller controls which representation to use.
      const matchingGroupIndex = eventGroups.findIndex((group) => group.matcher === req.matcher);
      const updatedGroups =
        matchingGroupIndex === -1
          ? [
              ...eventGroups,
              {
                ...(req.matcher !== undefined ? { matcher: req.matcher } : {}),
                hooks: [entry],
              },
            ]
          : eventGroups.map((group, index) =>
              index === matchingGroupIndex ? { ...group, hooks: [...group.hooks, entry] } : group,
            );

      return {
        hooks: {
          ...hooks,
          hooks: {
            ...(hooks.hooks ?? {}),
            [req.event]: updatedGroups,
          },
        },
        result: { added: true },
        changed: true,
      };
    });

    return result;
  }

  /**
   * Remove hook entries from the specified config scope.
   *
   * Removes all hooks where `entry.event === req.event` and
   * `entry.command.includes(req.match.commandContains)`.
   * @param req - Removal criteria and targeting options. `scope` selects the
   *   config file; `projectDir` is required when `scope` is `'project'`.
   *   `event` is the event name to match. `match.commandContains` is the
   *   command substring filter — any hook whose command contains this string
   *   is removed.
   * @returns `{ removed: n }` where `n` is the count of removed hooks.
   */
  public async removeHook(req: {
    projectDir?: string;
    scope: CodexScope;
    event: string;
    match: { commandContains: string };
  }): Promise<CodexConfigHooksRemoveResponse> {
    const filePath = this.resolvePathForScope(req.scope, req.projectDir);

    const { result } = await this.modifyHooksFile(filePath, (hooks) => {
      const eventGroups = hooks.hooks?.[req.event] ?? [];
      let removed = 0;
      const updatedGroups = eventGroups
        .map((group) => {
          const remainingHandlers = group.hooks.filter((handler) => {
            const parseResult = CodexNativeCommandHookSchema.safeParse(handler);
            const shouldRemove = parseResult.success && parseResult.data.command.includes(req.match.commandContains);
            if (shouldRemove) removed += 1;
            return !shouldRemove;
          });
          return { ...group, hooks: remainingHandlers };
        })
        .filter((group) => group.hooks.length > 0);

      if (removed === 0) {
        return { hooks, result: { removed }, changed: false };
      }

      const updatedHooksByEvent = { ...(hooks.hooks ?? {}) };
      if (updatedGroups.length === 0) {
        delete updatedHooksByEvent[req.event];
      } else {
        updatedHooksByEvent[req.event] = updatedGroups;
      }

      return {
        hooks: { ...hooks, hooks: updatedHooksByEvent },
        result: { removed },
        changed: true,
      };
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve config file path for a given scope.
   *
   * For `'project'` scope, `projectDir` must be provided. For `'global'`
   * scope, `projectDir` is ignored.
   * @param scope - Target config scope.
   * @param projectDir - Optional absolute path to the project root.
   * @returns Absolute path to the `hooks.json` file for the given scope.
   * @throws When `scope === 'project'` and `projectDir` is absent.
   */
  private resolvePathForScope(scope: CodexScope, projectDir?: string): string {
    const paths = this.resolvePaths(projectDir);
    if (scope === 'project') {
      if (!paths.projectHooks) throw new Error('Cannot access project scope: projectDir is required');
      return paths.projectHooks;
    }
    return paths.globalHooks;
  }

  /**
   * Resolve settings paths, applying the optional test override when present.
   * @param projectDir - Optional project root passed through to
   *   {@link resolveCodexSettingsPaths} when no override is active.
   * @returns Resolved settings paths.
   */
  private resolvePaths(projectDir?: string): CodexSettingsPaths {
    if (this.pathsOverride !== undefined) {
      return this.pathsOverride;
    }
    return resolveCodexSettingsPaths(projectDir, this.configDir);
  }

  /**
   * Check whether the current process can write to a path.
   *
   * First tests the file itself (when it exists). If that check fails or the
   * file does not yet exist, walks up from the parent directory until an
   * existing ancestor is found and checks write permission there. This handles
   * the fresh-install case where neither the file nor its `.codex/` parent
   * exist yet — the write helper creates the tree via `mkdir({ recursive })`,
   * so writability depends on the nearest existing ancestor.
   * @param filePath - Absolute path to the file to test.
   * @returns `true` when the process has write access, `false` otherwise.
   */
  private async isWritable(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, fs.constants.W_OK);
      return true;
    } catch {
      // Walk up until we find an existing directory to check.
      let candidate = path.dirname(filePath);
      for (;;) {
        try {
          await fs.access(candidate, fs.constants.W_OK);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return false;
          }
          const parent = path.dirname(candidate);
          if (parent === candidate) return false;
          candidate = parent;
        }
      }
    }
  }

  /**
   * Read and parse a Codex `hooks.json` file.
   *
   * Returns an empty array when the file does not exist (`ENOENT`) or when no
   * command hooks are configured. Re-throws `SyntaxError` on corrupt JSON and
   * permission errors without swallowing. Throws a descriptive `Error` when the
   * native `hooks` tree fails schema validation.
   * @param filePath - Absolute path to the `hooks.json` file.
   * @returns Flattened command hook entries for public bus responses.
   * @throws When a `hooks` field is present but does not conform to Codex's
   *   native grouped hook schema.
   */
  private async readHooksFile(filePath: string): Promise<CodexHookEntry[]> {
    return this.flattenHooksFile(await this.readHooksDocument(filePath));
  }

  /**
   * Read and parse a native Codex `hooks.json` file.
   *
   * Missing files resolve to an empty native document. Unknown top-level and
   * nested fields are preserved by the schema so read-modify-write operations
   * can update a target hook without dropping newer Codex fields.
   * @param filePath - Absolute path to the `hooks.json` file.
   * @returns Parsed native hooks document.
   * @throws When JSON parsing fails or the `hooks` field is not a native Codex
   *   event-to-matcher-group map.
   */
  private async readHooksDocument(filePath: string): Promise<CodexNativeHooksFile> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...EMPTY_HOOKS_FILE };
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(content);
    const parseResult = CodexNativeHooksFileSchema.safeParse(parsed);
    if (!parseResult.success) {
      throw new Error(`Invalid hooks file ${filePath}: ${parseResult.error.message}`);
    }
    return parseResult.data;
  }

  /**
   * Flatten a native Codex hooks document into the public command-hook view.
   * @param document - Native Codex hooks document.
   * @returns Flat command-hook entries ordered by event, matcher group, then
   *   handler order.
   */
  private flattenHooksFile(document: CodexNativeHooksFile): CodexHookEntry[] {
    const entries: CodexHookEntry[] = [];
    for (const [event, groups] of Object.entries(document.hooks ?? {})) {
      for (const group of groups) {
        for (const rawHandler of group.hooks) {
          const parseResult = CodexNativeCommandHookSchema.safeParse(rawHandler);
          if (!parseResult.success) continue;
          const handler = parseResult.data;
          entries.push({
            event,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
            command: handler.command,
            ...(handler.timeout !== undefined
              ? { timeout: handler.timeout }
              : handler.timeoutSec !== undefined
                ? { timeout: handler.timeoutSec }
                : {}),
          });
        }
      }
    }
    return entries;
  }

  /**
   * Read, modify, and atomically write a Codex `hooks.json` file.
   *
   * Delegates serialization and atomic I/O to {@link atomicModifyFile}.
   * The parent directory is created automatically when absent.  Write errors
   * surface to the current caller; the mutex queue continues regardless.
   * @param filePath - Absolute path to the `hooks.json` file to modify.
   * @param modifier - Pure function that receives the current native hooks
   *   document and returns the updated document, whether it changed, and a
   *   caller-defined result value.
   * @returns The `result` value produced by the modifier.
   */
  private async modifyHooksFile<T>(
    filePath: string,
    modifier: (hooks: CodexNativeHooksFile) => { hooks: CodexNativeHooksFile; result: T; changed: boolean },
  ): Promise<{ result: T }> {
    const result = await atomicModifyFile<CodexNativeHooksFile, T>(
      filePath,
      { ...EMPTY_HOOKS_FILE },
      writeMutex,
      (rawContent) => {
        const parseResult = CodexNativeHooksFileSchema.safeParse(rawContent);
        if (!parseResult.success) {
          throw new Error(`Invalid hooks file ${filePath}: ${parseResult.error.message}`);
        }
        return parseResult.data;
      },
      (hooks) => {
        const { hooks: updated, result: innerResult, changed } = modifier(hooks);
        return { content: updated, changed, result: innerResult };
      },
    );
    return { result };
  }
}

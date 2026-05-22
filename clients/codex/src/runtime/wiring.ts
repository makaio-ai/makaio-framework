/**
 * Codex wiring helpers.
 *
 * Pure functions that translate between the Codex `hooks.json` configuration
 * and the framework wiring contract. No bus dependency — callers are
 * responsible for providing a {@link CodexClientSettings} instance and
 * dispatching responses onto the bus.
 *
 * ## Wiring groups
 * - `session-events` — one entry per hook event declared in the Codex client
 *   definition that maps to a `client.session.*` framework subject.  When
 *   fired by the Codex CLI these hooks invoke a command of the form
 *   `makaio hook received codex <EventName>`, which the framework ingress
 *   bridge picks up and normalises.
 * @packageDocumentation
 */

import type {
  ClientWiringEntry,
  ClientWiringApplyResponse,
  ClientWiringRemoveResponse,
} from '@makaio/subsystem-client';
import { buildHookCommand, deriveSessionEventDescriptors } from '@makaio/subsystem-client';
import { clientDefinition } from '../definition.js';
import type { CodexClientSettings } from './client-settings.js';
import type { CodexScope } from '../schemas/config.js';

/**
 * Minimal settings API required by Codex wiring helpers.
 *
 * The concrete {@link CodexClientSettings} class satisfies this shape, while
 * tests can provide a structurally typed fake without unsafe casts.
 */
export interface CodexWiringSettings {
  /** List effective hook configuration. */
  listHooks: CodexClientSettings['listHooks'];
  /** Add a hook definition to a scope. */
  addHook: CodexClientSettings['addHook'];
  /** Remove hook definitions from a scope. */
  removeHook: CodexClientSettings['removeHook'];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Substring used to identify Makaio-managed Codex hook commands.
 *
 * The full command for a given event takes the form:
 * `<makaioCommand> hook received codex <EventName>`
 *
 * This sentinel is written verbatim by {@link applyCodexWiring} and used as
 * the `commandContains` filter in {@link removeCodexWiring}.
 */
export const CODEX_HOOK_COMMAND_SENTINEL = 'hook received codex';

// ---------------------------------------------------------------------------
// Derived wiring descriptors (module-scoped, computed once)
// ---------------------------------------------------------------------------

/**
 * Descriptors for all session-events hooks derived from the client definition.
 *
 * Only events with a defined `frameworkSubject` are included — events without
 * one are Codex-internal and do not need framework wiring.
 */
const SESSION_EVENTS = deriveSessionEventDescriptors(clientDefinition);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the wiring entry list, annotated with installation status, by
 * comparing the expected entries against the currently installed Codex hooks.
 *
 * Reads hooks from the global scope only when `projectDir` is absent; includes
 * project-scope hooks when `projectDir` is provided.
 * @param settings - {@link CodexClientSettings} instance for hook I/O.
 * @param makaioCommand - Base makaio shell command written into the config.
 * @param projectDir - Optional absolute project directory.  When absent only
 *   the global scope is checked.
 * @returns Object containing all wiring entries with `installed` flags.
 */
export async function buildCodexWiringList(
  settings: CodexWiringSettings,
  makaioCommand: string,
  projectDir?: string,
): Promise<{ entries: ClientWiringEntry[] }> {
  const { effective } = await settings.listHooks(projectDir !== undefined ? { projectDir } : {});

  const entries: ClientWiringEntry[] = SESSION_EVENTS.map(({ eventName }) => {
    const sentinel = `${CODEX_HOOK_COMMAND_SENTINEL} ${eventName}`;
    const command = buildHookCommand(makaioCommand, CODEX_HOOK_COMMAND_SENTINEL, eventName);
    const installed = effective.some((entry) => entry.event === eventName && entry.command.includes(sentinel));
    return {
      group: 'session-events',
      name: eventName,
      installed,
      command,
    };
  });

  return { entries };
}

/**
 * Install all session-event wiring entries into the specified scope.
 *
 * The operation uses replace semantics when `makaioCommand` changes: if a hook
 * for an event already contains the sentinel but with a different command
 * prefix, the old hook is removed before the new one is added.  When the
 * identical command is already present the entry is skipped unchanged.
 * @param settings - {@link CodexClientSettings} instance for hook I/O.
 * @param scope - Target scope (`'global'` or `'project'`).
 * @param makaioCommand - Base makaio shell command written into each hook.
 * @param projectDir - Absolute project directory.  Required when `scope` is
 *   `'project'`; ignored for `'global'`.
 * @returns Counts of applied (newly written or replaced) and skipped (already
 *   present) entries.
 */
export async function applyCodexWiring(
  settings: CodexWiringSettings,
  scope: CodexScope,
  makaioCommand: string,
  projectDir?: string,
): Promise<ClientWiringApplyResponse> {
  let applied = 0;
  let skipped = 0;

  const { perScope } = await settings.listHooks(projectDir !== undefined ? { projectDir } : {});
  const scopeRecord = perScope.find((s) => s.scope === scope);
  const scopeHooks = scopeRecord?.hooks ?? [];

  for (const { eventName } of SESSION_EVENTS) {
    const sentinel = `${CODEX_HOOK_COMMAND_SENTINEL} ${eventName}`;
    const command = buildHookCommand(makaioCommand, CODEX_HOOK_COMMAND_SENTINEL, eventName);

    const existingEntry = scopeHooks.find((entry) => entry.event === eventName && entry.command.includes(sentinel));

    if (existingEntry !== undefined) {
      if (existingEntry.command === command) {
        // Identical hook already installed — nothing to do.
        skipped += 1;
        continue;
      }
      // Same sentinel but different command prefix — remove the stale entry
      // before installing the updated one.
      await settings.removeHook({
        scope,
        event: eventName,
        match: { commandContains: sentinel },
        ...(projectDir !== undefined ? { projectDir } : {}),
      });
    }

    const result = await settings.addHook({
      scope,
      event: eventName,
      command,
      ...(projectDir !== undefined ? { projectDir } : {}),
    });
    if (result.added) {
      applied += 1;
    } else {
      skipped += 1;
    }
  }

  return { applied, skipped };
}

/**
 * Remove all Makaio-managed session-event wiring entries from the specified
 * scope.
 *
 * Entries that are not present are silently ignored — the operation is
 * idempotent.
 * @param settings - {@link CodexClientSettings} instance for hook I/O.
 * @param scope - Target scope (`'global'` or `'project'`).
 * @param projectDir - Absolute project directory.  Required when `scope` is
 *   `'project'`; ignored for `'global'`.
 * @returns Count of entries actually removed from the config file.
 */
export async function removeCodexWiring(
  settings: CodexWiringSettings,
  scope: CodexScope,
  projectDir?: string,
): Promise<ClientWiringRemoveResponse> {
  let removed = 0;

  for (const { eventName } of SESSION_EVENTS) {
    const result = await settings.removeHook({
      scope,
      event: eventName,
      match: { commandContains: `${CODEX_HOOK_COMMAND_SENTINEL} ${eventName}` },
      ...(projectDir !== undefined ? { projectDir } : {}),
    });
    removed += result.removed;
  }

  return { removed };
}

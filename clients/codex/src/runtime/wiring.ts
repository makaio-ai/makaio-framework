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
import {
  buildClientCommand,
  buildHookCommand,
  deriveSessionEventDescriptors,
  DEFAULT_HOOK_HANDLE_TIMEOUT_MS,
} from '@makaio/subsystem-client';
import { clientDefinition } from '../definition.js';
import type { CodexClientSettings } from './client-settings.js';
import type { CodexScope } from '../schemas/config.js';
import { CODEX_INTERACTION_BLOCKABILITY } from './hook-response-contracts.js';

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
/** Sentinel for synchronous Codex hook responses. */
export const CODEX_HOOK_HANDLE_COMMAND_SENTINEL = 'hook handle codex';

/**
 * Timeout for request-mode hooks on context-only (non-blockable) interactions.
 *
 * `hook handle` has no `--debounce-failure`, so a down server would stall every
 * prompt and subagent spawn for the full timeout; context-only hooks fail fast.
 * Blockable interactions retain {@link DEFAULT_HOOK_HANDLE_TIMEOUT_MS} because
 * those must complete before the native client can proceed.
 */
export const CONTEXT_ONLY_HOOK_HANDLE_TIMEOUT_MS = 1000;

// ---------------------------------------------------------------------------
// Derived wiring descriptors (module-scoped, computed once)
// ---------------------------------------------------------------------------

/**
 * Descriptors for all hook events derived from the client definition.
 *
 * Includes every event declared in the definition's `hookEvents` array,
 * regardless of whether it carries a `frameworkSubject`.  Events without a
 * framework mapping (e.g. `PostCompact`) are still wired so that the raw
 * ingress reaches the bus for Codex-specific consumers.
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

  const entries: ClientWiringEntry[] = SESSION_EVENTS.map(({ eventName, mode }) => {
    const command = buildModeCommand(makaioCommand, eventName, mode);
    const installed = effective.some((entry) => entry.event === eventName && entry.command === command);
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

  for (const { eventName, mode } of SESSION_EVENTS) {
    const sentinel = `${mode === 'request' ? CODEX_HOOK_HANDLE_COMMAND_SENTINEL : CODEX_HOOK_COMMAND_SENTINEL} ${eventName}`;
    const command = buildModeCommand(makaioCommand, eventName, mode);

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
    for (const sentinel of [CODEX_HOOK_COMMAND_SENTINEL, CODEX_HOOK_HANDLE_COMMAND_SENTINEL]) {
      const result = await settings.removeHook({
        scope,
        event: eventName,
        match: { commandContains: `${sentinel} ${eventName}` },
        ...(projectDir !== undefined ? { projectDir } : {}),
      });
      removed += result.removed;
    }
  }

  return { removed };
}

/**
 * Build the managed command for one capability-derived hook mode.
 *
 * For request-mode hooks the timeout is derived from the event's blockability:
 * blockable interactions get {@link DEFAULT_HOOK_HANDLE_TIMEOUT_MS} (5 s);
 * non-blockable, context-only interactions get
 * {@link CONTEXT_ONLY_HOOK_HANDLE_TIMEOUT_MS} (1 s) so a down server does not
 * stall every prompt or subagent spawn for the full duration.
 * @param makaioCommand - Makaio CLI executable.
 * @param eventName - Native Codex event name (used to look up blockability).
 * @param mode - Capability-derived transport mode.
 * @returns Shell-safe managed hook command.
 */
function buildModeCommand(makaioCommand: string, eventName: string, mode: 'event' | 'request'): string {
  if (mode !== 'request') {
    return buildHookCommand(makaioCommand, CODEX_HOOK_COMMAND_SENTINEL, eventName, undefined, ['--debounce-failure']);
  }
  const isBlockable = CODEX_INTERACTION_BLOCKABILITY.some(
    (entry) => entry.interaction === eventName && entry.blockable,
  );
  const timeoutMs = isBlockable ? DEFAULT_HOOK_HANDLE_TIMEOUT_MS : CONTEXT_ONLY_HOOK_HANDLE_TIMEOUT_MS;
  return buildClientCommand(makaioCommand, [
    '--no-launch',
    ...CODEX_HOOK_HANDLE_COMMAND_SENTINEL.split(' '),
    eventName,
    '--timeout',
    String(timeoutMs),
  ]);
}

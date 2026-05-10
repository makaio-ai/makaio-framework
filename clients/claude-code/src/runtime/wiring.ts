/**
 * Claude Code wiring logic.
 *
 * Pure functions that build, apply, and remove Claude Code native settings
 * entries required for Makaio hook ingress.  These functions have no bus
 * dependency and operate entirely on a {@link ClaudeCodeClientSettings}
 * instance, making them straightforward to unit-test with a mock.
 *
 * **Session-events group:** One hook per `hookEvents` entry that carries a
 * `frameworkSubject`.  The hook command is:
 *   `${makaioCommand} hook received claude-code ${eventName}`
 *
 * The command sentinel `'hook received claude-code'` is used for removal and
 * installation detection.
 *
 * **Usage-stream group:** A single statusline entry with name `'statusline'`.
 * The command is: `${makaioCommand} claude statusline`
 *
 * The command sentinel `'claude statusline'` is used for detection and removal.
 * @packageDocumentation
 */

import type { ClientWiringEntry } from '@makaio/clients-core';
import { buildClientCommand, buildHookCommand, deriveSessionEventDescriptors } from '@makaio/clients-core';

import { clientDefinition } from '../definition.js';
import type { ClaudeCodeClientSettings } from './client-settings.js';
import type { ClaudeCodeScope } from '../schemas/config.js';

/**
 * Minimal settings API required by Claude Code wiring helpers.
 *
 * The concrete {@link ClaudeCodeClientSettings} class satisfies this shape,
 * while tests can provide a structurally typed fake without unsafe casts.
 */
export interface ClaudeCodeWiringSettings {
  /** List effective hook configuration. */
  listHooks: ClaudeCodeClientSettings['listHooks'];
  /** Add a hook definition to a scope. */
  addHook: ClaudeCodeClientSettings['addHook'];
  /** Remove hook definitions from a scope. */
  removeHook: ClaudeCodeClientSettings['removeHook'];
  /** List effective statusline configuration. */
  listStatusline: ClaudeCodeClientSettings['listStatusline'];
  /** Set the statusline for a scope. */
  setStatusline: ClaudeCodeClientSettings['setStatusline'];
  /** Remove the statusline for a scope. */
  removeStatusline: ClaudeCodeClientSettings['removeStatusline'];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sentinel string embedded in every hook command written by Makaio.
 *
 * Used both to generate commands and to detect / remove previously installed
 * hooks via a substring match.
 */
const HOOK_COMMAND_SENTINEL = 'hook received claude-code';

/**
 * Sentinel string embedded in the statusline command written by Makaio.
 *
 * Used both to generate the command and to detect whether the effective
 * statusline is a Makaio-managed one, regardless of which binary prefix was
 * used.
 */
const STATUSLINE_COMMAND_SENTINEL = 'claude statusline';

// ---------------------------------------------------------------------------
// Derived wiring descriptors (module-scoped, computed once)
// ---------------------------------------------------------------------------

/**
 * Descriptors for all session-events hooks derived from the client definition.
 *
 * Only hook events that carry a `frameworkSubject` are included — events
 * without one (e.g. `SubagentStop`, `Notification`) are Claude-specific raw
 * events that Makaio does not need to observe via a hook.
 */
const SESSION_EVENTS_DESCRIPTORS = deriveSessionEventDescriptors(clientDefinition);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the statusline command string.
 * @param makaioCommand - The Makaio CLI binary name or path (e.g. `'makaio'`).
 * @param upstreamCommand - Existing shell command to proxy through the
 *   statusline bridge.
 * @returns The full statusline command string.
 */
function buildStatuslineCommand(makaioCommand: string, upstreamCommand?: string): string {
  const args =
    upstreamCommand === undefined
      ? STATUSLINE_COMMAND_SENTINEL.split(' ')
      : [
          ...STATUSLINE_COMMAND_SENTINEL.split(' '),
          '--upstream-command',
          'sh',
          '--upstream-args-json',
          JSON.stringify(['-c', upstreamCommand]),
        ];
  return buildClientCommand(makaioCommand, args);
}

/**
 * Search the effective hooks map for the first command string that contains
 * the given sentinel for the specified event.
 *
 * Returns the full command string when found so the caller can compare it
 * against the desired command and decide whether a replacement is needed.
 * @param effective - Effective hooks map from {@link ClaudeCodeClientSettings.listHooks}.
 * @param eventName - Claude Code hook event name to search.
 * @param sentinel - Sentinel substring that must appear in the command.
 * @returns The first matching command string, or `null` when none is found.
 */
// Uses runtime type checks instead of a Zod schema because the effective
// hooks map is parsed JSON whose shape varies per Claude Code version —
// the traversal is intentionally defensive against unexpected structures.
function findManagedHookCommand(
  effective: Record<string, unknown[]>,
  eventName: string,
  sentinel: string,
): string | null {
  const groups = effective[eventName];
  if (!Array.isArray(groups)) return null;

  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue;
    const hooksArr = (group as Record<string, unknown>)['hooks'];
    if (!Array.isArray(hooksArr)) continue;
    for (const hook of hooksArr) {
      if (typeof hook !== 'object' || hook === null) continue;
      const cmd = (hook as Record<string, unknown>)['command'];
      if (typeof cmd === 'string' && cmd.includes(sentinel)) return cmd;
    }
  }
  return null;
}

/**
 * Check whether the effective hooks map contains a command that starts with
 * the sentinel for a given event name.
 *
 * The check intentionally uses `includes` on the full command string so that
 * the installed hook is detected regardless of trailing arguments or options
 * that a future version might append.
 * @param effective - Effective hooks map from {@link ClaudeCodeClientSettings.listHooks}.
 * @param eventName - Claude Code hook event name to check.
 * @param sentinel - Sentinel string that must appear in the command.
 * @returns `true` when at least one hook command matching the sentinel exists.
 */
function isHookInstalled(effective: Record<string, unknown[]>, eventName: string, sentinel: string): boolean {
  return findManagedHookCommand(effective, eventName, sentinel) !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a list of wiring entries from the Claude Code client definition,
 * annotated with their current installation status in the native settings.
 *
 * Each entry in the `session-events` group corresponds to a hook event that
 * carries a `frameworkSubject`. The `installed` flag is `true` when the
 * effective hooks for that event already contain a command with the Makaio
 * sentinel string.
 *
 * The `usage-stream` group contains a single `statusline` entry whose
 * `installed` flag is `true` when the effective statusline command contains
 * the Makaio statusline sentinel.
 * @param settings - Settings instance scoped to the target project directory.
 * @param makaioCommand - Makaio CLI binary name or path used to build the
 *   command string (e.g. `'makaio'`).
 * @returns Wiring list response containing all known entries and their status.
 */
export async function buildClaudeCodeWiringList(
  settings: ClaudeCodeWiringSettings,
  makaioCommand: string,
): Promise<{ entries: ClientWiringEntry[] }> {
  const [{ effective: effectiveHooks }, { effective: effectiveStatusline }] = await Promise.all([
    settings.listHooks(),
    settings.listStatusline(),
  ]);

  const entries: ClientWiringEntry[] = SESSION_EVENTS_DESCRIPTORS.map(({ eventName }) => {
    const sentinel = `${HOOK_COMMAND_SENTINEL} ${eventName}`;
    const command = buildHookCommand(makaioCommand, HOOK_COMMAND_SENTINEL, eventName);
    const installed = isHookInstalled(effectiveHooks, eventName, sentinel);
    return { group: 'session-events', name: eventName, installed, command };
  });

  const statuslineCommand = buildStatuslineCommand(makaioCommand);
  const statuslineInstalled =
    effectiveStatusline !== null && effectiveStatusline.command.includes(STATUSLINE_COMMAND_SENTINEL);
  entries.push({
    group: 'usage-stream',
    name: 'statusline',
    installed: statuslineInstalled,
    command: statuslineCommand,
  });

  return { entries };
}

/**
 * Install all Makaio wiring entries into the specified Claude Code settings
 * scope.
 *
 * Each session-events hook is added via {@link ClaudeCodeClientSettings.addHook}
 * with `matcher: ''` for catch-all matching.  The statusline entry is written
 * via {@link ClaudeCodeClientSettings.setStatusline}.
 *
 * The operation uses replace semantics when `makaioCommand` changes: if a hook
 * for an event already contains the sentinel but with a different command
 * prefix, the old hook is removed before the new one is added.  When the
 * identical command is already present the entry is counted as skipped.
 *
 * **Statusline pass-through:** when the target scope already has a non-Makaio
 * statusline command, the previous shell command is preserved by passing it to
 * the statusline bridge as an upstream `sh -c` renderer.  Makaio-managed entries
 * (those whose command contains `STATUSLINE_COMMAND_SENTINEL`) are never
 * double-wrapped.
 * @param settings - Settings instance scoped to the target project directory.
 * @param scope - Claude Code settings scope to write into (`'user'`, `'project'`,
 *   or `'local'`).
 * @param makaioCommand - Makaio CLI binary name or path to embed in hook
 *   commands and the statusline command (e.g. `'makaio'`).
 * @returns Counts of entries applied and skipped.
 */
export async function applyClaudeCodeWiring(
  settings: ClaudeCodeWiringSettings,
  scope: ClaudeCodeScope,
  makaioCommand: string,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  const { perScope } = await settings.listHooks();
  const scopeRecord = perScope.find((s) => s.scope === scope);
  const scopeEvents: Record<string, unknown[]> = scopeRecord?.events ?? {};

  // Sequential: addHook writes to the same config file per scope, and the
  // internal mutex would serialize parallel calls anyway. Sequential keeps
  // the applied/skipped bookkeeping straightforward.
  for (const { eventName } of SESSION_EVENTS_DESCRIPTORS) {
    const sentinel = `${HOOK_COMMAND_SENTINEL} ${eventName}`;
    const command = buildHookCommand(makaioCommand, HOOK_COMMAND_SENTINEL, eventName);

    const existingCommand = findManagedHookCommand(scopeEvents, eventName, sentinel);

    if (existingCommand !== null) {
      if (existingCommand === command) {
        // Identical hook already installed — nothing to do.
        skipped++;
        continue;
      }
      // Same sentinel but different command prefix — remove the stale entry
      // before installing the updated one.
      await settings.removeHook({
        scope,
        eventName,
        match: { commandContains: sentinel },
      });
    }

    const result = await settings.addHook({
      scope,
      eventName,
      matcher: '',
      hook: { type: 'command', command },
    });
    if (result.added) {
      applied++;
    } else {
      skipped++;
    }
  }

  // Read the current per-scope statusline so we can embed an existing non-Makaio
  // command as --upstream, preserving the previous statusline in pass-through mode.
  const { perScope: statuslinePerScope } = await settings.listStatusline();
  const existingScopedStatusline = statuslinePerScope.find((e) => e.scope === scope)?.value ?? null;
  const existingStatuslineCommand =
    existingScopedStatusline !== null && !existingScopedStatusline.command.includes(STATUSLINE_COMMAND_SENTINEL)
      ? existingScopedStatusline.command
      : null;

  const statuslineCommand = buildStatuslineCommand(makaioCommand, existingStatuslineCommand ?? undefined);

  const statuslineResult = await settings.setStatusline({
    scope,
    value: { type: 'command', command: statuslineCommand },
  });
  // setStatusline is idempotent: when the previous value already contains the
  // sentinel command the modifier returns `current` unchanged and the file is
  // not rewritten.  We count it as applied when previous was absent or
  // different, and as skipped when the identical command was already present.
  if (statuslineResult.previous !== null && statuslineResult.previous.command === statuslineCommand) {
    skipped++;
  } else {
    applied++;
  }

  return { applied, skipped };
}

/**
 * Remove all Makaio wiring entries from the specified Claude Code settings
 * scope.
 *
 * Each session-events hook is removed by matching the command sentinel
 * `'hook received claude-code <eventName>'` via
 * {@link ClaudeCodeClientSettings.removeHook}. The statusline entry is removed
 * via {@link ClaudeCodeClientSettings.removeStatusline} when its command
 * contains the Makaio statusline sentinel. Entries that are not present are
 * silently skipped.
 * @param settings - Settings instance scoped to the target project directory.
 * @param scope - Claude Code settings scope to remove from (`'user'`,
 *   `'project'`, or `'local'`).
 * @returns Total number of wiring definitions removed across all entries.
 */
export async function removeClaudeCodeWiring(
  settings: ClaudeCodeWiringSettings,
  scope: ClaudeCodeScope,
): Promise<{ removed: number }> {
  let removed = 0;

  for (const { eventName } of SESSION_EVENTS_DESCRIPTORS) {
    const result = await settings.removeHook({
      scope,
      eventName,
      match: { commandContains: `${HOOK_COMMAND_SENTINEL} ${eventName}` },
    });
    removed += result.removed;
  }

  // Only remove the statusline when the *target scope itself* has a
  // Makaio-managed entry (command contains the sentinel).  Reading perScope
  // instead of `effective` prevents two failure modes:
  //   1. A narrower scope's Makaio entry shadowing a missing user-scope entry,
  //      causing removeStatusline to no-op silently on the wrong scope.
  //   2. A narrower scope's non-Makaio entry hiding a Makaio entry in a
  //      broader scope, leaving it as an orphan.
  const { perScope } = await settings.listStatusline();
  const scopeEntry = perScope.find((e) => e.scope === scope);
  const scopeValue = scopeEntry?.value ?? null;
  if (scopeValue !== null && scopeValue.command.includes(STATUSLINE_COMMAND_SENTINEL)) {
    const statuslineResult = await settings.removeStatusline({ scope });
    if (statuslineResult.removed) {
      removed++;
    }
  }

  return { removed };
}

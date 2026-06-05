/**
 * Claude Code wiring logic.
 *
 * Pure functions that build, apply, and remove Claude Code native settings
 * entries required for Makaio hook ingress.  These functions have no bus
 * dependency and operate entirely on a {@link ClaudeCodeClientSettings}
 * instance, making them straightforward to unit-test with a mock.
 *
 * **Session-events group:** One hook per `hookEvents` entry that carries a
 * `frameworkSubject`.  The hook command depends on the event's `mode`:
 * - `mode: 'event'`   → `${makaioCommand} hook received claude-code ${eventName}`
 * - `mode: 'request'` → `${makaioCommand} --no-launch hook handle claude-code ${eventName} --timeout 5000`
 *
 * The command sentinels `'hook received claude-code'` and
 * `'hook handle claude-code'` are used for removal and installation detection.
 *
 * **Usage-stream group:** A single statusline entry with name `'statusline'`.
 * The command is: `${makaioCommand} claude statusline`
 *
 * The command sentinel `'claude statusline'` is used for detection and removal.
 * @packageDocumentation
 */

import type { ClientWiringEntry } from '@makaio/subsystem-client';
import {
  buildClientCommand,
  DEFAULT_HOOK_HANDLE_TIMEOUT_MS,
  deriveSessionEventDescriptors,
} from '@makaio/subsystem-client';

import { clientDefinition } from '../definition.js';
import type { ClaudeCodeClientSettings } from './client-settings.js';
import type { ClaudeCodeScope } from '../schemas/config.js';
import {
  extractUpstreamCommand,
  HOOK_COMMAND_SENTINEL,
  HOOK_HANDLE_COMMAND_SENTINEL,
  STATUSLINE_COMMAND_SENTINEL,
} from './managed-wiring.js';

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
  /** Acknowledge Claude Code's dangerous-mode launch prompt for a scope. */
  setSkipDangerousModePermissionPrompt?: ClaudeCodeClientSettings['setSkipDangerousModePermissionPrompt'];
}

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
 * Resolved hook command descriptor for a single wiring event.
 */
interface HookDescriptor {
  /** Sentinel substring embedded in the command (used for detection and removal). */
  sentinel: string;
  /** CLI flags inserted between the executable and the sentinel. */
  rootFlags: readonly string[];
  /** CLI flags appended after the event name. */
  trailingFlags: readonly string[];
}

/**
 * Resolve the sentinel, root flags, and trailing flags for a hook event.
 *
 * - `'event'` — fire-and-forget; uses `HOOK_COMMAND_SENTINEL` with
 *   `--debounce-failure` as a root flag and no trailing flags.
 * - `'request'` — request/response; uses `HOOK_HANDLE_COMMAND_SENTINEL` with
 *   `--no-launch` as a root flag and `--timeout 5000` appended after the
 *   event name.
 * @param mode - Hook interaction mode from the event descriptor.
 * @returns Sentinel, root flags inserted before the sentinel, and trailing flags
 *   appended after the event name.
 */
function resolveHookDescriptor(mode: 'event' | 'request'): HookDescriptor {
  if (mode === 'request') {
    return {
      sentinel: HOOK_HANDLE_COMMAND_SENTINEL,
      rootFlags: ['--no-launch'],
      trailingFlags: ['--timeout', String(DEFAULT_HOOK_HANDLE_TIMEOUT_MS)],
    };
  }
  return {
    sentinel: HOOK_COMMAND_SENTINEL,
    rootFlags: ['--debounce-failure'],
    trailingFlags: [],
  };
}

/**
 * Build the full hook command string for a single session-event wiring entry,
 * selecting the sentinel and flags based on the event's interaction mode.
 *
 * - `'event'` mode produces: `[envPairs...] makaioCommand --debounce-failure hook received claude-code eventName`
 * - `'request'` mode produces: `[envPairs...] makaioCommand --no-launch hook handle claude-code eventName --timeout 5000`
 * @param makaioCommand - Makaio CLI binary name or path.
 * @param mode - Hook interaction mode from the event descriptor.
 * @param eventName - Native hook event name.
 * @param envPairs - Optional `KEY=value` pairs prepended before the executable.
 * @returns Full hook command string to write into the client's native config.
 */
function buildModeAwareHookCommand(
  makaioCommand: string,
  mode: 'event' | 'request',
  eventName: string,
  envPairs?: readonly string[],
): string {
  const { sentinel, rootFlags, trailingFlags } = resolveHookDescriptor(mode);
  return buildClientCommand(
    makaioCommand,
    [...rootFlags, ...sentinel.split(' '), eventName, ...trailingFlags],
    envPairs,
  );
}

/**
 * Find a stale Makaio-managed hook command for an event, checking both the
 * current-mode sentinel and the alternate-mode sentinel.
 *
 * When a hook event's mode changes (e.g. `'event'` → `'request'`), the
 * previously installed command may carry the old sentinel.  This helper
 * searches both to ensure the caller can remove the stale entry.
 * @param scopeEvents - Per-scope events map for the target scope.
 * @param eventName - Claude Code hook event name to search.
 * @param primarySentinel - Sentinel for the current descriptor mode.
 * @param alternateSentinel - Sentinel for the opposite mode.
 * @returns The stale command and the sentinel to use for removal, or `null`
 *   when no managed hook exists for this event.
 */
function findStaleHookCommand(
  scopeEvents: Record<string, unknown[]>,
  eventName: string,
  primarySentinel: string,
  alternateSentinel: string,
): { command: string; sentinel: string } | null {
  const fromPrimary = findManagedHookCommand(scopeEvents, eventName, primarySentinel);
  if (fromPrimary !== null) {
    return { command: fromPrimary, sentinel: primarySentinel };
  }
  const fromAlternate = findManagedHookCommand(scopeEvents, eventName, alternateSentinel);
  if (fromAlternate !== null) {
    return { command: fromAlternate, sentinel: alternateSentinel };
  }
  return null;
}

/**
 * Build the statusline command string.
 * @param makaioCommand - The Makaio CLI binary name or path (e.g. `'makaio'`).
 * @param upstreamCommand - Existing shell command to proxy through the
 *   statusline bridge.
 * @param envPairs - Optional `KEY=value` pairs prepended before the executable.
 * @returns The full statusline command string.
 */
function buildStatuslineCommand(makaioCommand: string, upstreamCommand?: string, envPairs?: readonly string[]): string {
  const args =
    upstreamCommand === undefined
      ? STATUSLINE_COMMAND_SENTINEL.split(' ')
      : [...STATUSLINE_COMMAND_SENTINEL.split(' '), '--upstream-command', ...platformShellArgs(upstreamCommand)];
  return buildClientCommand(makaioCommand, args, envPairs);
}

/**
 * Build the shell invocation args for an upstream command string.
 *
 * On Windows, `cmd /c` is used because `sh` is not available. On POSIX
 * platforms, `sh -c` is the standard way to execute a command string.
 * @param command - Shell command string to execute.
 * @returns `[shell, '--upstream-args-json', jsonArgs]` tokens.
 */
function platformShellArgs(command: string): string[] {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd' : 'sh';
  const flag = isWindows ? '/c' : '-c';
  return [shell, '--upstream-args-json', JSON.stringify([flag, command])];
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
 * Check whether any managed hook command for an event exactly matches the
 * expected command.
 * @param effective - Effective hooks map from {@link ClaudeCodeClientSettings.listHooks}.
 * @param eventName - Claude Code hook event name to search.
 * @param sentinel - Sentinel substring identifying Makaio-managed commands.
 * @param command - Exact command string expected for the hook.
 * @returns `true` when a matching managed hook exists.
 */
function hasManagedHookCommand(
  effective: Record<string, unknown[]>,
  eventName: string,
  sentinel: string,
  command: string,
): boolean {
  const groups = effective[eventName];
  if (!Array.isArray(groups)) return false;

  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue;
    const hooksArr = (group as Record<string, unknown>)['hooks'];
    if (!Array.isArray(hooksArr)) continue;
    for (const hook of hooksArr) {
      if (typeof hook !== 'object' || hook === null) continue;
      const cmd = (hook as Record<string, unknown>)['command'];
      if (typeof cmd === 'string' && cmd.includes(sentinel) && cmd === command) return true;
    }
  }

  return false;
}

/**
 * Check whether the effective hooks map contains the exact command expected
 * for a given event name.
 *
 * Installation status drives rewiring decisions, so sentinel-only matches are
 * not enough: older commands missing required root flags must report as stale.
 * @param effective - Effective hooks map from {@link ClaudeCodeClientSettings.listHooks}.
 * @param eventName - Claude Code hook event name to check.
 * @param hookSentinel - The base sentinel to use (e.g. `HOOK_COMMAND_SENTINEL`
 *   or `HOOK_HANDLE_COMMAND_SENTINEL`) without the trailing event name.
 * @param command - Exact command string expected for the hook.
 * @returns `true` when the exact hook command exists.
 */
function isHookInstalled(
  effective: Record<string, unknown[]>,
  eventName: string,
  hookSentinel: string,
  command: string,
): boolean {
  const sentinel = `${hookSentinel} ${eventName}`;
  return hasManagedHookCommand(effective, eventName, sentinel, command);
}

/**
 * Remove stale managed hook commands before installing the current command.
 *
 * When both the current-mode sentinel and alternate-mode sentinel are present,
 * both must be removed before adding the replacement to avoid duplicate hook
 * ingress after mode or flag migrations.
 * @param settings - Settings instance scoped to the target project directory.
 * @param scope - Claude Code settings scope to write into.
 * @param eventName - Claude Code hook event name being replaced.
 * @param scopeEvents - Existing per-scope hooks map.
 * @param stale - Stale command found for either the primary or alternate sentinel.
 * @param alternateSentinel - Opposite-mode sentinel for the same event.
 */
async function removeStaleHookCommands(
  settings: ClaudeCodeWiringSettings,
  scope: ClaudeCodeScope,
  eventName: string,
  scopeEvents: Record<string, unknown[]>,
  stale: { command: string; sentinel: string },
  alternateSentinel: string,
): Promise<void> {
  await settings.removeHook({
    scope,
    eventName,
    match: { commandContains: stale.sentinel },
  });

  if (stale.sentinel === alternateSentinel) return;
  if (findManagedHookCommand(scopeEvents, eventName, alternateSentinel) === null) return;

  await settings.removeHook({
    scope,
    eventName,
    match: { commandContains: alternateSentinel },
  });
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
 * @param envPairs - Optional `KEY=value` pairs prepended before the executable
 *   in every generated command string.
 * @returns Wiring list response containing all known entries and their status.
 */
export async function buildClaudeCodeWiringList(
  settings: ClaudeCodeWiringSettings,
  makaioCommand: string,
  envPairs?: readonly string[],
): Promise<{ entries: ClientWiringEntry[] }> {
  const [{ effective: effectiveHooks }, { effective: effectiveStatusline }] = await Promise.all([
    settings.listHooks(),
    settings.listStatusline(),
  ]);

  const entries: ClientWiringEntry[] = SESSION_EVENTS_DESCRIPTORS.map(({ eventName, mode }) => {
    const { sentinel } = resolveHookDescriptor(mode);
    const command = buildModeAwareHookCommand(makaioCommand, mode, eventName, envPairs);
    const installed = isHookInstalled(effectiveHooks, eventName, sentinel, command);
    return { group: 'session-events', name: eventName, installed, command };
  });

  const statuslineCommand = buildStatuslineCommand(makaioCommand, undefined, envPairs);
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
 * @param envPairs - Optional `KEY=value` pairs prepended before the executable
 *   in every generated command string.
 * @param options - Optional launch-related settings to persist with the wiring.
 * @returns Counts of entries applied and skipped.
 */
export async function applyClaudeCodeWiring(
  settings: ClaudeCodeWiringSettings,
  scope: ClaudeCodeScope,
  makaioCommand: string,
  envPairs?: readonly string[],
  options?: { skipDangerousModePermissionPrompt?: boolean },
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  if (options?.skipDangerousModePermissionPrompt === true) {
    await settings.setSkipDangerousModePermissionPrompt?.({ scope, enabled: true });
  }

  const { perScope } = await settings.listHooks();
  const scopeRecord = perScope.find((s) => s.scope === scope);
  const scopeEvents: Record<string, unknown[]> = scopeRecord?.events ?? {};

  // Sequential: addHook writes to the same config file per scope, and the
  // internal mutex would serialize parallel calls anyway. Sequential keeps
  // the applied/skipped bookkeeping straightforward.
  for (const { eventName, mode } of SESSION_EVENTS_DESCRIPTORS) {
    const { sentinel: baseSentinel } = resolveHookDescriptor(mode);
    const sentinel = `${baseSentinel} ${eventName}`;
    const command = buildModeAwareHookCommand(makaioCommand, mode, eventName, envPairs);

    // Check both the primary and alternate-mode sentinels to handle migrations
    // (e.g. PreToolUse moving from 'hook received' to 'hook handle') cleanly.
    const alternateSentinel = `${mode === 'request' ? HOOK_COMMAND_SENTINEL : HOOK_HANDLE_COMMAND_SENTINEL} ${eventName}`;
    const stale = findStaleHookCommand(scopeEvents, eventName, sentinel, alternateSentinel);

    if (stale !== null) {
      if (stale.command === command) {
        // Primary entry is correct — but an orphaned alternate-mode entry may
        // still be present (e.g. old 'hook received' alongside correct new
        // 'hook handle').  Remove it so the config stays clean after a mode
        // migration even when the primary sentinel already matched correctly.
        const orphanedAlternate = findManagedHookCommand(scopeEvents, eventName, alternateSentinel);
        if (orphanedAlternate !== null) {
          await settings.removeHook({
            scope,
            eventName,
            match: { commandContains: alternateSentinel },
          });
        }
        skipped++;
        continue;
      }
      // Stale entry found (different command or different mode sentinel) — remove
      // before installing the updated one.
      await removeStaleHookCommands(settings, scope, eventName, scopeEvents, stale, alternateSentinel);
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

  const statuslineCommand = buildStatuslineCommand(makaioCommand, existingStatuslineCommand ?? undefined, envPairs);

  const statuslineResult = await settings.setStatusline({
    scope,
    value: { ...(existingScopedStatusline ?? {}), type: 'command', command: statuslineCommand },
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
 * Each session-events hook is removed by matching both the primary sentinel for
 * the event's current mode (`'hook received claude-code <eventName>'` or
 * `'hook handle claude-code <eventName>'`) and the alternate sentinel, via
 * {@link ClaudeCodeClientSettings.removeHook}.  Checking both ensures that
 * mode migrations leave no orphaned entries.  The statusline entry is removed
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

  // Remove hooks for both sentinels per event to handle mode migrations
  // cleanly.  An event that was previously installed as 'hook received' and
  // is now declared as 'hook handle' (or vice versa) must have its old entry
  // cleaned up even though the descriptor now points to the other sentinel.
  for (const { eventName, mode } of SESSION_EVENTS_DESCRIPTORS) {
    const { sentinel: primarySentinel } = resolveHookDescriptor(mode);
    const alternateSentinel = mode === 'request' ? HOOK_COMMAND_SENTINEL : HOOK_HANDLE_COMMAND_SENTINEL;

    const primary = await settings.removeHook({
      scope,
      eventName,
      match: { commandContains: `${primarySentinel} ${eventName}` },
    });
    removed += primary.removed;

    const alternate = await settings.removeHook({
      scope,
      eventName,
      match: { commandContains: `${alternateSentinel} ${eventName}` },
    });
    removed += alternate.removed;
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
    const restoredCommand = extractUpstreamCommand(scopeValue.command);
    if (restoredCommand !== null) {
      // Restore the original statusline that was embedded as --upstream,
      // preserving any extra fields (e.g. padding) from the Makaio entry.
      const { command: _, ...extraFields } = scopeValue;
      await settings.setStatusline({
        scope,
        value: { ...extraFields, type: 'command', command: restoredCommand },
      });
    } else {
      await settings.removeStatusline({ scope });
    }
    removed++;
  }

  return { removed };
}

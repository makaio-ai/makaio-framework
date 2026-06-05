/**
 * Pure modifier helpers for Claude Code settings write operations.
 *
 * Each helper receives the current parsed settings object and a request
 * descriptor, applies the relevant mutation, and returns the updated object
 * together with a side-effect-free status value.  No I/O is performed and no
 * module state is touched — callers are responsible for persisting the result.
 * @packageDocumentation
 */

import type { ClaudeCodeHookDefinition, ClaudeCodeHookMatcherGroup } from '../schemas/config.js';
import { getRawHooksMap, hooksAreIdentical, isHookMatcherGroup, isStatuslineValue } from './client-settings-guards.js';
import {
  extractUpstreamCommand,
  HOOK_COMMAND_SENTINEL,
  HOOK_HANDLE_COMMAND_SENTINEL,
  STATUSLINE_COMMAND_SENTINEL,
} from './managed-wiring.js';

// ---------------------------------------------------------------------------
// Hook add
// ---------------------------------------------------------------------------

/**
 * Result of {@link applyHookAddition}.
 */
export interface HookAdditionResult {
  /** Updated settings object; same reference as `current` when nothing changed. */
  updated: Record<string, unknown>;
  /** `true` when the hook was appended; `false` when it already existed. */
  added: boolean;
}

/**
 * Request descriptor for {@link applyHookAddition}.
 */
export interface HookAdditionRequest {
  /** Hook event name to target (e.g. `'PreToolUse'`). */
  readonly eventName: string;
  /** Optional matcher string to scope the group. */
  readonly matcher?: string;
  /** Hook definition to append. */
  readonly hook: ClaudeCodeHookDefinition;
}

/**
 * Apply a hook addition to a raw settings object.
 *
 * If a group with the same `matcher` already exists, the hook is appended to
 * it; otherwise a new group is created.  The operation is idempotent: if an
 * identical hook (same `type`, `command`, and `timeout`) already exists in
 * the group, the original object reference is returned unchanged.
 * @param current - Current raw settings object from the file.
 * @param req - Hook addition request descriptor.
 * @returns Updated settings object and whether a hook was added.  When `added`
 *   is `false`, `updated` is the same reference as `current`.
 */
export function applyHookAddition(current: Record<string, unknown>, req: HookAdditionRequest): HookAdditionResult {
  const hooksMap = getRawHooksMap(current['hooks']) ?? {};
  const rawEntries = hooksMap[req.eventName];
  const eventEntries: unknown[] = Array.isArray(rawEntries) ? [...rawEntries] : [];
  const idx = eventEntries.findIndex((entry) => isHookMatcherGroup(entry) && entry.matcher === req.matcher);

  if (idx !== -1) {
    const existingGroup = eventEntries[idx] as ClaudeCodeHookMatcherGroup;
    if (existingGroup.hooks.some((h) => hooksAreIdentical(h, req.hook))) {
      return { updated: current, added: false };
    }
    eventEntries[idx] = { ...existingGroup, hooks: [...existingGroup.hooks, req.hook] };
    return {
      updated: { ...current, hooks: { ...hooksMap, [req.eventName]: eventEntries } },
      added: true,
    };
  }

  const newGroup: ClaudeCodeHookMatcherGroup = {
    ...(req.matcher !== undefined ? { matcher: req.matcher } : {}),
    hooks: [req.hook],
  };
  return {
    updated: { ...current, hooks: { ...hooksMap, [req.eventName]: [...eventEntries, newGroup] } },
    added: true,
  };
}

// ---------------------------------------------------------------------------
// Hook remove
// ---------------------------------------------------------------------------

/**
 * Result of {@link applyHookRemoval}.
 */
export interface HookRemovalResult {
  /** Updated settings object; same reference as `current` when nothing was removed. */
  updated: Record<string, unknown>;
  /** Number of hook definitions removed. */
  removed: number;
}

/**
 * Request descriptor for {@link applyHookRemoval}.
 */
export interface HookRemovalRequest {
  /** Hook event name to target (e.g. `'PreToolUse'`). */
  readonly eventName: string;
  /** Criteria for matching hooks to remove. */
  readonly match: { readonly commandContains: string };
}

/**
 * Apply a hook removal to a raw settings object.
 *
 * Removes all hooks whose `command` field contains the given substring.
 * After removal, empty matcher groups (groups with no hooks left) and empty
 * events (events with no groups left) are pruned.  All other keys are
 * preserved.
 *
 * When nothing matches, the original object reference is returned unchanged.
 * @param current - Current raw settings object from the file.
 * @param req - Hook removal request descriptor.
 * @returns Updated settings object and the count of removed hook definitions.
 *   When `removed` is `0`, `updated` is the same reference as `current`.
 */
export function applyHookRemoval(current: Record<string, unknown>, req: HookRemovalRequest): HookRemovalResult {
  const hooksMap = getRawHooksMap(current['hooks']);
  if (hooksMap === null) {
    return { updated: current, removed: 0 };
  }

  const eventEntries = hooksMap[req.eventName];
  if (!Array.isArray(eventEntries)) {
    return { updated: current, removed: 0 };
  }

  const updatedEntries: unknown[] = [];
  let removed = 0;
  for (const group of eventEntries) {
    if (!isHookMatcherGroup(group)) {
      updatedEntries.push(group);
      continue;
    }

    const remaining = group.hooks.filter((h) => !h.command.includes(req.match.commandContains));
    removed += group.hooks.length - remaining.length;
    if (remaining.length > 0) {
      updatedEntries.push({ ...group, hooks: remaining });
    }
    // Empty group is pruned by not pushing it
  }

  if (removed === 0) {
    return { updated: current, removed: 0 };
  }

  const updatedHooksMap: Record<string, unknown> = { ...hooksMap };
  if (updatedEntries.length > 0) {
    updatedHooksMap[req.eventName] = updatedEntries;
  } else {
    // Prune empty event
    delete updatedHooksMap[req.eventName];
  }

  return { updated: { ...current, hooks: updatedHooksMap }, removed };
}

// ---------------------------------------------------------------------------
// Managed wiring scrub
// ---------------------------------------------------------------------------

/**
 * Remove stale Makaio-managed wiring from a raw Claude Code settings object.
 *
 * This operates at file level instead of through scoped settings paths so it
 * can be applied to copied `settings.json` and `settings.local.json` alike.
 * Non-Makaio hooks, statuslines, and unknown keys are preserved.
 * @param current - Current raw settings object from the file.
 * @returns Updated settings object; same reference when no managed wiring was present.
 */
export function scrubManagedClaudeCodeWiring(current: Record<string, unknown>): Record<string, unknown> {
  let updated = current;
  const hooksMap = getRawHooksMap(current['hooks']);
  if (hooksMap !== null) {
    let nextHooksMap: Record<string, unknown> | undefined;

    for (const [eventName, eventEntries] of Object.entries(hooksMap)) {
      if (!Array.isArray(eventEntries)) continue;

      const remainingGroups: unknown[] = [];
      let removedFromEvent = false;
      for (const group of eventEntries) {
        if (!isHookMatcherGroup(group)) {
          remainingGroups.push(group);
          continue;
        }

        const remainingHooks = group.hooks.filter(
          (hook) =>
            !hook.command.includes(HOOK_COMMAND_SENTINEL) && !hook.command.includes(HOOK_HANDLE_COMMAND_SENTINEL),
        );
        if (remainingHooks.length !== group.hooks.length) {
          removedFromEvent = true;
        }
        if (remainingHooks.length > 0) {
          remainingGroups.push({ ...group, hooks: remainingHooks });
        }
      }

      if (removedFromEvent) {
        nextHooksMap ??= { ...hooksMap };
        if (remainingGroups.length > 0) {
          nextHooksMap[eventName] = remainingGroups;
        } else {
          delete nextHooksMap[eventName];
        }
      }
    }

    if (nextHooksMap !== undefined) {
      updated = { ...updated, hooks: nextHooksMap };
    }
  }

  const statusLine = updated['statusLine'];
  if (isStatuslineValue(statusLine) && statusLine.command.includes(STATUSLINE_COMMAND_SENTINEL)) {
    const upstreamCommand = extractUpstreamCommand(statusLine.command);
    if (upstreamCommand !== null) {
      updated = { ...updated, statusLine: { ...statusLine, command: upstreamCommand } };
    } else {
      const next = { ...updated };
      delete next['statusLine'];
      updated = next;
    }
  }

  return updated;
}

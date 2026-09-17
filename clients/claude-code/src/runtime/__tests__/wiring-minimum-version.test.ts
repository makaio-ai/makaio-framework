/**
 * Unit tests for minimum-version enforcement in the Claude Code wiring module.
 *
 * Verifies that `buildClaudeCodeWiringList` and `applyClaudeCodeWiring` skip
 * events whose `minimumVersion` exceeds the detected binary version, that an
 * unknown version wires every event, and that `removeClaudeCodeWiring` removes
 * every declared event regardless of version.
 *
 * `PostCompact` is the only event with a declared `minimumVersion` in the
 * current client definition (`'2.1.76'`) and is used as the sole test vehicle
 * for version-gating logic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCodeWiringSettings } from '../wiring.js';
import { applyClaudeCodeWiring, buildClaudeCodeWiringList, removeClaudeCodeWiring } from '../wiring.js';
import { clientDefinition } from '../../definition.js';
import { HOOK_COMMAND_SENTINEL, HOOK_HANDLE_COMMAND_SENTINEL } from '../managed-wiring.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The versioned event exercised by all minimum-version tests. */
const VERSIONED_EVENT = 'PostCompact';

/** The declared minimum version for {@link VERSIONED_EVENT}. */
const MIN_VERSION = '2.1.76';

/** A version string strictly below {@link MIN_VERSION}. */
const OLD_VERSION = '2.1.75';

/** The exact {@link MIN_VERSION} boundary. */
const EXACT_VERSION = MIN_VERSION;

/** A version string above {@link MIN_VERSION}. */
const NEW_VERSION = '2.2.0';

/** Total hook events declared in the client definition. */
const TOTAL_EVENT_COUNT = clientDefinition.runtimeCapabilities.hookEvents.length;

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Create a mock {@link ClaudeCodeWiringSettings} with all required methods.
 * All writes (`addHook`, `removeHook`, `setStatusline`, `removeStatusline`,
 * `setSkipDangerousModePermissionPrompt`) are vitest spies.
 */
function createMockSettings(): ClaudeCodeWiringSettings {
  return {
    listHooks: vi.fn().mockResolvedValue({ effective: {}, perScope: [] }),
    addHook: vi.fn().mockResolvedValue({ added: true }),
    removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
    listStatusline: vi.fn().mockResolvedValue({ effective: null, perScope: [] }),
    setStatusline: vi.fn().mockResolvedValue({ previous: null, applied: null }),
    removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
    setSkipDangerousModePermissionPrompt: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// buildClaudeCodeWiringList — version filtering
// ---------------------------------------------------------------------------

describe('buildClaudeCodeWiringList — minimum-version filtering', () => {
  let settings: ClaudeCodeWiringSettings;

  beforeEach(() => {
    settings = createMockSettings();
  });

  it('omits PostCompact from entries when binaryVersion is below minimumVersion', async () => {
    const { entries } = await buildClaudeCodeWiringList(settings, 'makaio', undefined, OLD_VERSION);
    const sessionEntries = entries.filter((e) => e.group === 'session-events');
    expect(sessionEntries.map((e) => e.name)).not.toContain(VERSIONED_EVENT);
    // All other declared events must still be present.
    expect(sessionEntries.length).toBe(TOTAL_EVENT_COUNT - 1);
  });

  it('includes PostCompact when binaryVersion equals minimumVersion exactly', async () => {
    const { entries } = await buildClaudeCodeWiringList(settings, 'makaio', undefined, EXACT_VERSION);
    const sessionEntries = entries.filter((e) => e.group === 'session-events');
    expect(sessionEntries.map((e) => e.name)).toContain(VERSIONED_EVENT);
    expect(sessionEntries.length).toBe(TOTAL_EVENT_COUNT);
  });

  it('includes PostCompact when binaryVersion is above minimumVersion', async () => {
    const { entries } = await buildClaudeCodeWiringList(settings, 'makaio', undefined, NEW_VERSION);
    const sessionEntries = entries.filter((e) => e.group === 'session-events');
    expect(sessionEntries.map((e) => e.name)).toContain(VERSIONED_EVENT);
    expect(sessionEntries.length).toBe(TOTAL_EVENT_COUNT);
  });

  it('includes PostCompact when binaryVersion is null (unknown version)', async () => {
    const { entries } = await buildClaudeCodeWiringList(settings, 'makaio', undefined, null);
    const sessionEntries = entries.filter((e) => e.group === 'session-events');
    expect(sessionEntries.map((e) => e.name)).toContain(VERSIONED_EVENT);
    expect(sessionEntries.length).toBe(TOTAL_EVENT_COUNT);
  });

  it('includes PostCompact when binaryVersion is undefined (unknown version)', async () => {
    const { entries } = await buildClaudeCodeWiringList(settings, 'makaio', undefined, undefined);
    const sessionEntries = entries.filter((e) => e.group === 'session-events');
    expect(sessionEntries.map((e) => e.name)).toContain(VERSIONED_EVENT);
    expect(sessionEntries.length).toBe(TOTAL_EVENT_COUNT);
  });

  it('includes PostCompact when binaryVersion argument is omitted entirely', async () => {
    const { entries } = await buildClaudeCodeWiringList(settings, 'makaio');
    const sessionEntries = entries.filter((e) => e.group === 'session-events');
    expect(sessionEntries.map((e) => e.name)).toContain(VERSIONED_EVENT);
    expect(sessionEntries.length).toBe(TOTAL_EVENT_COUNT);
  });
});

// ---------------------------------------------------------------------------
// applyClaudeCodeWiring — version filtering
// ---------------------------------------------------------------------------

describe('applyClaudeCodeWiring — minimum-version filtering', () => {
  let settings: ClaudeCodeWiringSettings;

  beforeEach(() => {
    settings = createMockSettings();
  });

  it('does not call addHook for PostCompact when binaryVersion is below minimumVersion', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });
    const addHookSpy = settings.addHook as ReturnType<typeof vi.fn>;
    const calledEventNames: string[] = addHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    expect(calledEventNames).not.toContain(VERSIONED_EVENT);
  });

  it('applied and skipped counts exclude PostCompact when binaryVersion is below minimumVersion', async () => {
    // With OLD_VERSION, TOTAL_EVENT_COUNT - 1 hooks are eligible; all get
    // applied because addHook returns added=true.  Plus one statusline entry.
    const { applied, skipped } = await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });
    // applied = (TOTAL_EVENT_COUNT - 1) hooks + 1 statusline
    expect(applied).toBe(TOTAL_EVENT_COUNT - 1 + 1);
    expect(skipped).toBe(0);
  });

  it('calls addHook for PostCompact when binaryVersion is null (unknown version)', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, { binaryVersion: null });
    const addHookSpy = settings.addHook as ReturnType<typeof vi.fn>;
    const calledEventNames: string[] = addHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    expect(calledEventNames).toContain(VERSIONED_EVENT);
  });

  it('calls addHook for PostCompact when binaryVersion is undefined (unknown version)', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, { binaryVersion: undefined });
    const addHookSpy = settings.addHook as ReturnType<typeof vi.fn>;
    const calledEventNames: string[] = addHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    expect(calledEventNames).toContain(VERSIONED_EVENT);
  });
});

// ---------------------------------------------------------------------------
// removeClaudeCodeWiring — version-agnostic removal
// ---------------------------------------------------------------------------

describe('removeClaudeCodeWiring — removes PostCompact regardless of version', () => {
  it('calls removeHook for PostCompact even when options would skip it during apply', async () => {
    const settings = createMockSettings();
    // removeClaudeCodeWiring takes no binaryVersion — it must always remove all
    // declared events to clean up a downgraded binary's leftover wiring.
    await removeClaudeCodeWiring(settings, 'user');
    const removeHookSpy = settings.removeHook as ReturnType<typeof vi.fn>;
    const calledEventNames: string[] = removeHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    expect(calledEventNames).toContain(VERSIONED_EVENT);
  });
});

// ---------------------------------------------------------------------------
// applyClaudeCodeWiring — stale-hook cleanup on version downgrade (F1)
// ---------------------------------------------------------------------------

/**
 * Build a mock {@link ClaudeCodeWiringSettings} that pre-populates the given
 * scope with a PostCompact hook command in perScope, simulating the state
 * after the event was installed by a newer binary.
 * @param scope - The target scope to populate.
 * @param command - Full hook command string to embed in the perScope record.
 * @returns Fully configured mock settings.
 */
function createMockSettingsWithInstalledPostCompact(
  scope: 'user' | 'project' | 'local',
  command: string,
): ClaudeCodeWiringSettings {
  return {
    listHooks: vi.fn().mockResolvedValue({
      effective: {},
      perScope: [
        {
          scope,
          events: {
            [VERSIONED_EVENT]: [{ hooks: [{ type: 'command', command }] }],
          },
        },
      ],
    }),
    addHook: vi.fn().mockResolvedValue({ added: true }),
    removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
    listStatusline: vi.fn().mockResolvedValue({ effective: null, perScope: [] }),
    setStatusline: vi.fn().mockResolvedValue({ previous: null, applied: null }),
    removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
    setSkipDangerousModePermissionPrompt: vi.fn().mockResolvedValue(undefined),
  };
}

describe('applyClaudeCodeWiring — stale-hook cleanup on binary downgrade', () => {
  it('removes a PostCompact primary-sentinel hook when binaryVersion drops below minimumVersion', async () => {
    // PostCompact uses 'event' mode (raw ingress, HOOK_COMMAND_SENTINEL).
    // Simulate state after having applied with 2.1.76+: perScope carries the
    // PostCompact hook that the newer binary installed.
    const primaryCommand = `makaio --debounce-failure ${HOOK_COMMAND_SENTINEL} ${VERSIONED_EVENT}`;
    const settings = createMockSettingsWithInstalledPostCompact('user', primaryCommand);

    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });

    const removeHookSpy = settings.removeHook as ReturnType<typeof vi.fn>;
    const removedEventNames: string[] = removeHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    expect(removedEventNames).toContain(VERSIONED_EVENT);
  });

  it('removes a PostCompact alternate-sentinel hook when binaryVersion drops below minimumVersion', async () => {
    // Alternate-mode sentinel: HOOK_HANDLE_COMMAND_SENTINEL (e.g. left over from
    // a mode migration of the event).
    const alternateCommand = `makaio --no-launch ${HOOK_HANDLE_COMMAND_SENTINEL} ${VERSIONED_EVENT} --timeout 1000`;
    const settings = createMockSettingsWithInstalledPostCompact('user', alternateCommand);

    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });

    const removeHookSpy = settings.removeHook as ReturnType<typeof vi.fn>;
    const removedEventNames: string[] = removeHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    expect(removedEventNames).toContain(VERSIONED_EVENT);
  });

  it('does not call addHook for PostCompact after the stale hook is removed', async () => {
    const primaryCommand = `makaio --debounce-failure ${HOOK_COMMAND_SENTINEL} ${VERSIONED_EVENT}`;
    const settings = createMockSettingsWithInstalledPostCompact('user', primaryCommand);

    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });

    const addHookSpy = settings.addHook as ReturnType<typeof vi.fn>;
    const addedEventNames: string[] = addHookSpy.mock.calls.map((args) => (args[0] as { eventName: string }).eventName);
    expect(addedEventNames).not.toContain(VERSIONED_EVENT);
  });

  it('does not remove hooks for events unrelated to the downgraded PostCompact', async () => {
    // Only PostCompact is installed in perScope; the cleanup loop must only
    // attempt removal for PostCompact (the unsupported event).  No other
    // removeHook call should target a different event name.
    const primaryCommand = `makaio --debounce-failure ${HOOK_COMMAND_SENTINEL} ${VERSIONED_EVENT}`;
    const settings = createMockSettingsWithInstalledPostCompact('user', primaryCommand);

    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });

    const removeHookSpy = settings.removeHook as ReturnType<typeof vi.fn>;
    const removedEventNames: string[] = removeHookSpy.mock.calls.map(
      (args) => (args[0] as { eventName: string }).eventName,
    );
    // removeHook is only called for the unsupported PostCompact event;
    // all other calls (if any) must also be for PostCompact.
    const nonPostCompactRemovals = removedEventNames.filter((name) => name !== VERSIONED_EVENT);
    expect(nonPostCompactRemovals).toHaveLength(0);
  });

  it('does not call removeHook when the stale PostCompact hook is absent from perScope', async () => {
    // Empty perScope — no hooks installed, so cleanup finds nothing to remove.
    const settings = createMockSettings();

    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      binaryVersion: OLD_VERSION,
    });

    const removeHookSpy = settings.removeHook as ReturnType<typeof vi.fn>;
    expect(removeHookSpy).not.toHaveBeenCalled();
  });
});

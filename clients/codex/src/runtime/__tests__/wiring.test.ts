/**
 * Unit tests for Codex wiring helpers.
 *
 * Tests cover {@link buildCodexWiringList}, {@link applyCodexWiring}, and
 * {@link removeCodexWiring} using a lightweight mock of
 * {@link CodexWiringSettings} that avoids filesystem I/O.
 *
 * The wiring functions accept an injected settings dependency (dependency
 * inversion), so mocking that interface is the correct unit-test approach —
 * it isolates command-building, sentinel detection, and apply/remove
 * orchestration from the real config I/O tested in the settings layer.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexHookEntry } from '../../schemas/config.js';
import { buildCodexWiringList, applyCodexWiring, removeCodexWiring } from '../wiring.js';
import type { CodexWiringSettings } from '../wiring.js';
import { CodexClientSettings } from '../client-settings.js';
import { readHooksJson, writeHooksJson } from './hooks-file-helpers.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock for {@link CodexWiringSettings}.
 *
 * The `effective` list is a flat array of {@link CodexHookEntry} values,
 * matching the real `listHooks` return shape.
 * @param effectiveHooks - Pre-seeded hook entries returned by `listHooks`.
 * @returns Mock settings object.
 */
function createMockSettings(effectiveHooks: CodexHookEntry[] = []): CodexWiringSettings {
  return {
    listHooks: vi.fn().mockResolvedValue({
      effective: effectiveHooks,
      perScope: [{ scope: 'global', path: '/fake/hooks.json', writable: true, hooks: effectiveHooks }],
    }),
    addHook: vi.fn().mockResolvedValue({ added: true }),
    removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
  };
}

// ---------------------------------------------------------------------------
// buildCodexWiringList
// ---------------------------------------------------------------------------

describe('buildCodexWiringList', () => {
  it('returns at least one entry', async () => {
    const settings = createMockSettings();
    const result = await buildCodexWiringList(settings, 'makaio');
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('marks all entries as not installed when no hooks exist', async () => {
    const settings = createMockSettings();
    const result = await buildCodexWiringList(settings, 'makaio');
    expect(result.entries.every((e) => !e.installed)).toBe(true);
  });

  it('marks an entry as installed when a matching command exists', async () => {
    const settings = createMockSettings([
      {
        event: 'SessionStart',
        command: 'makaio --debounce-failure hook received codex SessionStart',
      },
    ]);
    const result = await buildCodexWiringList(settings, 'makaio');
    const sessionStart = result.entries.find((e) => e.name === 'SessionStart');
    expect(sessionStart?.installed).toBe(true);
  });

  it('leaves other entries as not installed when only one matches', async () => {
    const settings = createMockSettings([
      {
        event: 'SessionStart',
        command: 'makaio --debounce-failure hook received codex SessionStart',
      },
    ]);
    const result = await buildCodexWiringList(settings, 'makaio');
    const notInstalled = result.entries.filter((e) => e.name !== 'SessionStart');
    expect(notInstalled.every((e) => !e.installed)).toBe(true);
  });

  it('marks stale commands without the debounce root flag as not installed', async () => {
    const settings = createMockSettings([
      {
        event: 'SessionStart',
        command: 'makaio hook received codex SessionStart',
      },
    ]);
    const result = await buildCodexWiringList(settings, 'makaio');
    const sessionStart = result.entries.find((e) => e.name === 'SessionStart');
    expect(sessionStart?.installed).toBe(false);
  });

  it('reads persisted hooks when deciding debounce-aware installation status', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wiring-list-'));
    const hooksPath = path.join(configDir, 'hooks.json');
    try {
      await writeHooksJson(hooksPath, [
        { event: 'SessionStart', command: 'makaio hook received codex SessionStart' },
        { event: 'UserPromptSubmit', command: 'makaio --debounce-failure hook received codex UserPromptSubmit' },
      ]);
      const settings = new CodexClientSettings({ globalHooks: hooksPath, projectHooks: null });

      const result = await buildCodexWiringList(settings, 'makaio');

      expect(result.entries.find((e) => e.name === 'SessionStart')?.installed).toBe(false);
      expect(result.entries.find((e) => e.name === 'UserPromptSubmit')?.installed).toBe(true);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('generates commands using the provided makaioCommand prefix', async () => {
    const settings = createMockSettings();
    const result = await buildCodexWiringList(settings, 'myapp');
    expect(result.entries.every((e) => e.command.startsWith('myapp '))).toBe(true);
  });

  it('calls listHooks with no eventName filter', async () => {
    const settings = createMockSettings();
    await buildCodexWiringList(settings, 'makaio');
    expect(settings.listHooks).toHaveBeenCalledWith({});
  });

  it('assigns every entry to the session-events group', async () => {
    const settings = createMockSettings();
    const result = await buildCodexWiringList(settings, 'makaio');
    expect(result.entries.every((e) => e.group === 'session-events')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyCodexWiring
// ---------------------------------------------------------------------------

describe('applyCodexWiring', () => {
  it('calls addHook for each session-events entry', async () => {
    const settings = createMockSettings();
    await applyCodexWiring(settings, 'global', 'makaio');
    expect(settings.addHook).toHaveBeenCalled();
  });

  it('returns applied count greater than zero', async () => {
    const settings = createMockSettings();
    const result = await applyCodexWiring(settings, 'global', 'makaio');
    expect(result.applied).toBeGreaterThan(0);
  });

  it('passes the correct scope to addHook', async () => {
    const settings = createMockSettings();
    await applyCodexWiring(settings, 'project', 'makaio', '/tmp/proj');
    const calls = vi.mocked(settings.addHook).mock.calls;
    expect(calls.every(([req]) => req.scope === 'project')).toBe(true);
  });

  it('passes projectDir to addHook when provided', async () => {
    const settings = createMockSettings();
    await applyCodexWiring(settings, 'project', 'makaio', '/tmp/proj');
    const calls = vi.mocked(settings.addHook).mock.calls;
    expect(calls.every(([req]) => req.projectDir === '/tmp/proj')).toBe(true);
  });

  it('skips already-installed entries and reflects the count', async () => {
    // Seed all hooks as installed so addHook returns added: false for each.
    const allInstalled: CodexHookEntry[] = [
      { event: 'SessionStart', command: 'makaio --debounce-failure hook received codex SessionStart' },
      { event: 'UserPromptSubmit', command: 'makaio --debounce-failure hook received codex UserPromptSubmit' },
      { event: 'PreToolUse', command: 'makaio --debounce-failure hook received codex PreToolUse' },
      { event: 'PostToolUse', command: 'makaio --debounce-failure hook received codex PostToolUse' },
      { event: 'Stop', command: 'makaio --debounce-failure hook received codex Stop' },
    ];
    const settings = createMockSettings(allInstalled);

    const result = await applyCodexWiring(settings, 'global', 'makaio');
    expect(settings.addHook).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('skips already-installed debounce-aware hooks through real settings I/O', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-wiring-apply-'));
    const hooksPath = path.join(configDir, 'hooks.json');
    try {
      const settings = new CodexClientSettings({ globalHooks: hooksPath, projectHooks: null });

      const first = await applyCodexWiring(settings, 'global', 'makaio');
      const second = await applyCodexWiring(settings, 'global', 'makaio');
      const persistedHooks = await readHooksJson(hooksPath);

      expect(first.applied).toBeGreaterThan(0);
      expect(second.applied).toBe(0);
      expect(second.skipped).toBe(persistedHooks.length);
      expect(persistedHooks).toHaveLength(first.applied);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('removes the stale hook before adding the updated one when the binary prefix changes', async () => {
    // Seed perScope with hooks that contain the sentinel but with a different
    // binary prefix ('makaio-dev' instead of 'makaio'). The effective list is
    // left empty so buildCodexWiringList would report them as not-installed —
    // applyCodexWiring reads perScope directly for replace detection.
    const staleHooks: CodexHookEntry[] = [
      { event: 'SessionStart', command: 'makaio-dev hook received codex SessionStart' },
      { event: 'UserPromptSubmit', command: 'makaio-dev hook received codex UserPromptSubmit' },
      { event: 'PreToolUse', command: 'makaio-dev hook received codex PreToolUse' },
      { event: 'PostToolUse', command: 'makaio-dev hook received codex PostToolUse' },
      { event: 'Stop', command: 'makaio-dev hook received codex Stop' },
    ];

    // Shared call log to assert removeHook precedes addHook for each event.
    const callLog: Array<{ op: 'remove' | 'add'; event: string }> = [];

    const settings: CodexWiringSettings = {
      listHooks: vi.fn().mockResolvedValue({
        effective: [],
        perScope: [{ scope: 'global', path: '/fake/hooks.json', writable: true, hooks: staleHooks }],
      }),
      addHook: vi.fn().mockImplementation(async (req: { event: string }) => {
        callLog.push({ op: 'add', event: req.event });
        return { added: true };
      }),
      removeHook: vi.fn().mockImplementation(async (req: { event: string }) => {
        callLog.push({ op: 'remove', event: req.event });
        return { removed: 1 };
      }),
    };

    const result = await applyCodexWiring(settings, 'global', 'makaio');

    // All stale entries must have been replaced — removeHook called once per event.
    expect(settings.removeHook).toHaveBeenCalledTimes(staleHooks.length);
    // All events must have been re-added — addHook called once per event.
    expect(settings.addHook).toHaveBeenCalledTimes(staleHooks.length);
    // applied count reflects the replacements (addHook returned added: true).
    expect(result.applied).toBe(staleHooks.length);
    expect(result.skipped).toBe(0);

    // For each event, the remove call must appear before the add call in the log.
    const events = staleHooks.map((h) => h.event);
    for (const event of events) {
      const removeIdx = callLog.findIndex((c) => c.op === 'remove' && c.event === event);
      const addIdx = callLog.findIndex((c) => c.op === 'add' && c.event === event);
      expect(removeIdx, `removeHook for ${event} not found in call log`).toBeGreaterThanOrEqual(0);
      expect(addIdx, `addHook for ${event} not found in call log`).toBeGreaterThanOrEqual(0);
      expect(removeIdx, `removeHook for ${event} must precede addHook`).toBeLessThan(addIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// removeCodexWiring
// ---------------------------------------------------------------------------

describe('removeCodexWiring', () => {
  it('calls removeHook for each session-events entry', async () => {
    const settings = createMockSettings();
    await removeCodexWiring(settings, 'global');
    expect(settings.removeHook).toHaveBeenCalled();
  });

  it('returns removed count greater than zero when hooks exist', async () => {
    const settings = createMockSettings();
    const result = await removeCodexWiring(settings, 'global');
    expect(result.removed).toBeGreaterThan(0);
  });

  it('passes the correct scope to removeHook', async () => {
    const settings = createMockSettings();
    await removeCodexWiring(settings, 'project', '/tmp/proj');
    const calls = vi.mocked(settings.removeHook).mock.calls;
    expect(calls.every(([req]) => req.scope === 'project')).toBe(true);
  });

  it('passes projectDir to removeHook when provided', async () => {
    const settings = createMockSettings();
    await removeCodexWiring(settings, 'project', '/tmp/proj');
    const calls = vi.mocked(settings.removeHook).mock.calls;
    expect(calls.every(([req]) => req.projectDir === '/tmp/proj')).toBe(true);
  });

  it('uses the CODEX hook command sentinel including the event name as the commandContains filter', async () => {
    const settings = createMockSettings();
    await removeCodexWiring(settings, 'global');
    const calls = vi.mocked(settings.removeHook).mock.calls;
    // Each call must narrow to its specific event name, not just the bare sentinel.
    expect(
      calls.every(([req]) => {
        const { event, match } = req;
        return match.commandContains === `hook received codex ${event}`;
      }),
    ).toBe(true);
  });
});

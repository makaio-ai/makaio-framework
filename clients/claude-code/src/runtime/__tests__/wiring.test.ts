/**
 * Unit tests for the Claude Code wiring module.
 *
 * Uses mock settings to verify the pure wiring orchestration logic without
 * any filesystem or bus involvement. The wiring functions accept a
 * `ClaudeCodeWiringSettings` dependency (dependency injection), so mocking
 * that interface is the correct unit-test approach — it isolates the
 * command-building, sentinel detection, and apply/remove orchestration from
 * the real config I/O, which is tested separately in the settings layer.
 *
 * See {@link buildClaudeCodeWiringList},
 * {@link applyClaudeCodeWiring}, and {@link removeClaudeCodeWiring}.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildClaudeCodeWiringList, applyClaudeCodeWiring, removeClaudeCodeWiring } from '../wiring.js';
import type { ClaudeCodeWiringSettings } from '../wiring.js';
import { ClaudeCodeClientSettings } from '../client-settings.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * A per-scope statusline entry used in mock settings.
 */
interface MockStatuslineEntry {
  scope: 'user' | 'project' | 'local';
  path: string;
  value: { type: 'command'; command: string } | null;
}

/**
 * Create a mock {@link ClaudeCodeWiringSettings} with all required methods.
 * @param existingHooks - Pre-populated effective hooks map returned by `listHooks`.
 * @param effectiveStatusline - Effective statusline value returned by `listStatusline`.
 * @param statuslinePerScope - Per-scope statusline entries returned by `listStatusline`.
 *   When omitted, `perScope` is empty.
 * @returns Mock settings object.
 */
function createMockSettings(
  existingHooks: Record<string, unknown[]> = {},
  effectiveStatusline: { type: 'command'; command: string } | null = null,
  statuslinePerScope: MockStatuslineEntry[] = [],
): ClaudeCodeWiringSettings {
  return {
    listHooks: vi.fn().mockResolvedValue({
      effective: existingHooks,
      perScope: [],
    }),
    addHook: vi.fn().mockResolvedValue({ added: true }),
    removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
    listStatusline: vi.fn().mockResolvedValue({
      effective: effectiveStatusline,
      perScope: statuslinePerScope,
    }),
    setStatusline: vi.fn().mockResolvedValue({
      previous: null,
      applied: { type: 'command', command: 'makaio claude statusline' },
    }),
    removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
    setSkipDangerousModePermissionPrompt: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// buildClaudeCodeWiringList
// ---------------------------------------------------------------------------

describe('buildClaudeCodeWiringList', () => {
  it('returns all session-events entries plus one statusline entry', async () => {
    const settings = createMockSettings();
    const result = await buildClaudeCodeWiringList(settings, 'makaio');
    expect(result.entries.length).toBeGreaterThan(0);
    const statuslineEntry = result.entries.find((e) => e.name === 'statusline');
    expect(statuslineEntry).toBeDefined();
    expect(statuslineEntry?.group).toBe('usage-stream');
  });

  it('marks all entries as installed=false when no hooks or statusline exist', async () => {
    const settings = createMockSettings();
    const result = await buildClaudeCodeWiringList(settings, 'makaio');
    expect(result.entries.every((e) => !e.installed)).toBe(true);
  });

  it('marks session-events entry as installed when matching hook command exists', async () => {
    const settings = createMockSettings({
      SessionStart: [{ hooks: [{ type: 'command', command: 'makaio hook received claude-code SessionStart' }] }],
    });
    const result = await buildClaudeCodeWiringList(settings, 'makaio');
    const sessionStart = result.entries.find((e) => e.name === 'SessionStart');
    expect(sessionStart?.installed).toBe(true);
  });

  it('marks statusline entry as installed when effective statusline contains the sentinel', async () => {
    const settings = createMockSettings({}, { type: 'command', command: 'makaio claude statusline' });
    const result = await buildClaudeCodeWiringList(settings, 'makaio');
    const statuslineEntry = result.entries.find((e) => e.name === 'statusline');
    expect(statuslineEntry?.installed).toBe(true);
  });

  it('marks statusline as not installed when effective statusline is a different command', async () => {
    const settings = createMockSettings({}, { type: 'command', command: 'some-other-tool status' });
    const result = await buildClaudeCodeWiringList(settings, 'makaio');
    const statuslineEntry = result.entries.find((e) => e.name === 'statusline');
    expect(statuslineEntry?.installed).toBe(false);
  });

  it('uses the provided makaioCommand in all command fields', async () => {
    const settings = createMockSettings();
    const result = await buildClaudeCodeWiringList(settings, 'makaio-dev');
    const hookEntry = result.entries.find((e) => e.name === 'SessionStart');
    expect(hookEntry?.command).toContain('makaio-dev');
    const statuslineEntry = result.entries.find((e) => e.name === 'statusline');
    expect(statuslineEntry?.command).toContain('makaio-dev');
    expect(statuslineEntry?.command).toBe('makaio-dev claude statusline');
  });

  it('prepends envPairs before the executable in all command fields', async () => {
    const settings = createMockSettings();
    const envPairs = ['MAKAIO_CONFIG_FILE=/path/to/config.ts', 'MAKAIO_HOME=/path/to/.makaio-dev'];
    const result = await buildClaudeCodeWiringList(settings, '/path/to/cli-entry.ts', envPairs);
    const hookEntry = result.entries.find((e) => e.name === 'SessionStart');
    expect(hookEntry?.command).toBe(
      'MAKAIO_CONFIG_FILE=/path/to/config.ts MAKAIO_HOME=/path/to/.makaio-dev /path/to/cli-entry.ts hook received claude-code SessionStart',
    );
    const statuslineEntry = result.entries.find((e) => e.name === 'statusline');
    expect(statuslineEntry?.command).toBe(
      'MAKAIO_CONFIG_FILE=/path/to/config.ts MAKAIO_HOME=/path/to/.makaio-dev /path/to/cli-entry.ts claude statusline',
    );
  });

  it('session-events entries belong to session-events group', async () => {
    const settings = createMockSettings();
    const result = await buildClaudeCodeWiringList(settings, 'makaio');
    const hookEntries = result.entries.filter((e) => e.group === 'session-events');
    expect(hookEntries.length).toBeGreaterThan(0);
    expect(hookEntries.every((e) => e.name !== 'statusline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyClaudeCodeWiring
// ---------------------------------------------------------------------------

describe('applyClaudeCodeWiring', () => {
  let settings: ClaudeCodeWiringSettings;

  beforeEach(() => {
    settings = createMockSettings();
  });

  it('calls addHook for each session-events entry', async () => {
    const result = await applyClaudeCodeWiring(settings, 'user', 'makaio');
    expect(settings.addHook).toHaveBeenCalled();
    expect(result.applied).toBeGreaterThan(0);
  });

  it('calls setStatusline with the statusline command', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio');
    expect(settings.setStatusline).toHaveBeenCalledWith({
      scope: 'user',
      value: { type: 'command', command: 'makaio claude statusline' },
    });
  });

  it('acknowledges the dangerous skip permissions prompt when requested', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio', undefined, {
      skipDangerousModePermissionPrompt: true,
    });

    expect(settings.setSkipDangerousModePermissionPrompt).toHaveBeenCalledWith({ scope: 'user', enabled: true });
  });

  it('persists dangerous skip permissions acknowledgement through real settings I/O', async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-wiring-settings-'));
    try {
      const realSettings = new ClaudeCodeClientSettings({ configDir });

      await applyClaudeCodeWiring(realSettings, 'user', 'makaio', undefined, {
        skipDangerousModePermissionPrompt: true,
      });

      const settingsPath = path.join(configDir, 'settings.json');
      const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
      expect(persisted['skipDangerousModePermissionPrompt']).toBe(true);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  it('quotes shell-sensitive Makaio paths in the statusline command', async () => {
    await applyClaudeCodeWiring(settings, 'user', "/Applications/Makaio CLI/bin/makai'o");
    expect(settings.setStatusline).toHaveBeenCalledWith({
      scope: 'user',
      value: { type: 'command', command: "'/Applications/Makaio CLI/bin/makai'\\''o' claude statusline" },
    });
  });

  it('counts the statusline as applied when setStatusline previous was null', async () => {
    (settings.setStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: null,
      applied: { type: 'command', command: 'makaio claude statusline' },
    });
    const result = await applyClaudeCodeWiring(settings, 'user', 'makaio');
    // statusline applied=1, plus all hooks applied
    expect(result.applied).toBeGreaterThan(0);
  });

  it('counts the statusline as skipped when identical command was already present', async () => {
    (settings.setStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: { type: 'command', command: 'makaio claude statusline' },
      applied: { type: 'command', command: 'makaio claude statusline' },
    });
    const result = await applyClaudeCodeWiring(settings, 'user', 'makaio');
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('counts skipped when addHook returns added=false', async () => {
    (settings.addHook as ReturnType<typeof vi.fn>).mockResolvedValue({ added: false });
    // setStatusline returns a new value (applied)
    (settings.setStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: null,
      applied: { type: 'command', command: 'makaio claude statusline' },
    });
    const result = await applyClaudeCodeWiring(settings, 'user', 'makaio');
    expect(result.skipped).toBeGreaterThan(0);
    // hooks are all skipped; statusline is applied
    expect(result.applied).toBe(1);
  });

  it('passes the correct scope to addHook', async () => {
    await applyClaudeCodeWiring(settings, 'project', 'makaio');
    const calls = (settings.addHook as ReturnType<typeof vi.fn>).mock.calls as [{ scope: string }][];
    expect(calls.every((args) => args[0].scope === 'project')).toBe(true);
  });

  it('passes the correct scope to setStatusline', async () => {
    await applyClaudeCodeWiring(settings, 'local', 'makaio');
    const call = (settings.setStatusline as ReturnType<typeof vi.fn>).mock.calls[0] as [{ scope: string }];
    expect(call[0].scope).toBe('local');
  });

  // Bug B: every addHook call must include matcher: '' for Claude Code catch-all format
  it('passes matcher empty string to addHook for catch-all matching', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio');
    const calls = (settings.addHook as ReturnType<typeof vi.fn>).mock.calls as [{ matcher?: string }][];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args[0].matcher === '')).toBe(true);
  });

  // Bug A: existing non-Makaio statusline must be passed through as the upstream renderer.
  it('embeds existing statusline command as upstream sh renderer when setting Makaio statusline', async () => {
    const existingCommand = 'npx -y ccstatusline@latest';
    const settingsWithExisting: ClaudeCodeWiringSettings = {
      listHooks: vi.fn().mockResolvedValue({ effective: {}, perScope: [] }),
      addHook: vi.fn().mockResolvedValue({ added: true }),
      removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
      listStatusline: vi.fn().mockResolvedValue({
        effective: { type: 'command', command: existingCommand },
        perScope: [
          {
            scope: 'user' as const,
            path: '~/.claude/settings.json',
            value: { type: 'command', command: existingCommand },
          },
        ],
      }),
      setStatusline: vi.fn().mockResolvedValue({
        previous: { type: 'command', command: existingCommand },
        applied: {
          type: 'command',
          command:
            'makaio claude statusline --upstream-command sh --upstream-args-json ' + `'["-c","${existingCommand}"]'`,
        },
      }),
      removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
    };

    await applyClaudeCodeWiring(settingsWithExisting, 'user', 'makaio');

    const setCall = (settingsWithExisting.setStatusline as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { value: { command: string } },
    ];
    expect(setCall[0].value.command).toBe(
      'makaio claude statusline --upstream-command sh --upstream-args-json ' + `'["-c","npx -y ccstatusline@latest"]'`,
    );
  });

  it('does not add upstream renderer args when no previous statusline exists', async () => {
    // Default mock has no existing statusline (listStatusline returns effective: null, perScope: [])
    await applyClaudeCodeWiring(settings, 'user', 'makaio');
    const setCall = (settings.setStatusline as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { value: { command: string } },
    ];
    expect(setCall[0].value.command).not.toContain('--upstream-command');
  });

  it('does not add upstream renderer args when previous statusline is already a Makaio command', async () => {
    const makaioCommand = 'makaio claude statusline';
    const settingsWithMakaio: ClaudeCodeWiringSettings = {
      listHooks: vi.fn().mockResolvedValue({ effective: {}, perScope: [] }),
      addHook: vi.fn().mockResolvedValue({ added: true }),
      removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
      listStatusline: vi.fn().mockResolvedValue({
        effective: { type: 'command', command: makaioCommand },
        perScope: [
          {
            scope: 'user' as const,
            path: '~/.claude/settings.json',
            value: { type: 'command', command: makaioCommand },
          },
        ],
      }),
      setStatusline: vi.fn().mockResolvedValue({
        previous: { type: 'command', command: makaioCommand },
        applied: { type: 'command', command: makaioCommand },
      }),
      removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
    };

    await applyClaudeCodeWiring(settingsWithMakaio, 'user', 'makaio');

    const setCall = (settingsWithMakaio.setStatusline as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { value: { command: string } },
    ];
    expect(setCall[0].value.command).not.toContain('--upstream-command');
  });

  it('writes hook commands containing the sentinel and event name', async () => {
    await applyClaudeCodeWiring(settings, 'user', 'makaio');
    const calls = (settings.addHook as ReturnType<typeof vi.fn>).mock.calls as [{ hook: { command: string } }][];
    const commandsWritten = calls.map((args) => args[0].hook.command);
    expect(commandsWritten.some((cmd) => cmd.includes('hook received claude-code'))).toBe(true);
  });

  it('prepends envPairs before the executable in hook and statusline commands', async () => {
    const envPairs = ['MAKAIO_CONFIG_FILE=/path/to/config.ts', 'MAKAIO_HOME=/path/to/.makaio-dev'];
    await applyClaudeCodeWiring(settings, 'user', '/path/to/cli-entry.ts', envPairs);

    const hookCalls = (settings.addHook as ReturnType<typeof vi.fn>).mock.calls as [{ hook: { command: string } }][];
    for (const [req] of hookCalls) {
      expect(req.hook.command).toMatch(/^MAKAIO_CONFIG_FILE=.+ MAKAIO_HOME=.+ \/path\/to\/cli-entry\.ts /);
    }

    const statuslineCalls = (settings.setStatusline as ReturnType<typeof vi.fn>).mock.calls as [
      { value: { command: string } },
    ][];
    expect(statuslineCalls[0][0].value.command).toMatch(
      /^MAKAIO_CONFIG_FILE=.+ MAKAIO_HOME=.+ \/path\/to\/cli-entry\.ts claude statusline/,
    );
  });

  it('removes stale hook before adding when sentinel matches but makaioCommand prefix differs (replace semantics)', async () => {
    // Seed perScope with hooks that have the sentinel for every framework-tracked
    // event but with a stale 'makaio-dev' prefix.  The replace path triggers
    // when existingCommand !== null && existingCommand !== desiredCommand.
    const stalePrefix = 'makaio-dev';
    const stalePerScope = [
      {
        scope: 'user' as const,
        path: '/home/.claude/settings.json',
        events: {
          SessionStart: [
            { hooks: [{ type: 'command' as const, command: `${stalePrefix} hook received claude-code SessionStart` }] },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command' as const, command: `${stalePrefix} hook received claude-code UserPromptSubmit` },
              ],
            },
          ],
          PreToolUse: [
            { hooks: [{ type: 'command' as const, command: `${stalePrefix} hook received claude-code PreToolUse` }] },
          ],
          PostToolUse: [
            { hooks: [{ type: 'command' as const, command: `${stalePrefix} hook received claude-code PostToolUse` }] },
          ],
          Stop: [{ hooks: [{ type: 'command' as const, command: `${stalePrefix} hook received claude-code Stop` }] }],
        },
      },
    ];

    const callLog: Array<{ op: 'remove' | 'add'; eventName: string }> = [];

    const staleSettings: ClaudeCodeWiringSettings = {
      listHooks: vi.fn().mockResolvedValue({
        effective: {},
        perScope: stalePerScope,
      }),
      addHook: vi.fn().mockImplementation(async (req: { eventName: string }) => {
        callLog.push({ op: 'add', eventName: req.eventName });
        return { added: true };
      }),
      removeHook: vi.fn().mockImplementation(async (req: { eventName: string }) => {
        callLog.push({ op: 'remove', eventName: req.eventName });
        return { removed: 1 };
      }),
      listStatusline: vi.fn().mockResolvedValue({ effective: null, perScope: [] }),
      setStatusline: vi
        .fn()
        .mockResolvedValue({ previous: null, applied: { type: 'command', command: 'makaio claude statusline' } }),
      removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
      setSkipDangerousModePermissionPrompt: vi.fn().mockResolvedValue(undefined),
    };

    const result = await applyClaudeCodeWiring(staleSettings, 'user', 'makaio');

    // removeHook must have been called for every stale entry — one per event.
    const removeCalls = (staleSettings.removeHook as ReturnType<typeof vi.fn>).mock.calls as [
      { scope: string; eventName: string; match: { commandContains: string } },
    ][];
    expect(removeCalls).toHaveLength(5);
    expect(removeCalls.every((args) => args[0].scope === 'user')).toBe(true);
    expect(removeCalls.map((args) => args[0].match.commandContains)).toEqual([
      'hook received claude-code SessionStart',
      'hook received claude-code UserPromptSubmit',
      'hook received claude-code PreToolUse',
      'hook received claude-code PostToolUse',
      'hook received claude-code Stop',
    ]);

    // addHook must have been called once per event with the new 'makaio' command.
    const addCalls = (staleSettings.addHook as ReturnType<typeof vi.fn>).mock.calls as [
      { scope: string; eventName: string; hook: { type: string; command: string } },
    ][];
    expect(addCalls).toHaveLength(5);
    expect(addCalls.every((args) => args[0].hook.command.startsWith('makaio '))).toBe(true);
    expect(addCalls.every((args) => !args[0].hook.command.startsWith('makaio-dev '))).toBe(true);

    // Replacements count as applied (addHook returned added=true), plus the statusline.
    expect(result.applied).toBe(6);
    expect(result.skipped).toBe(0);

    for (const eventName of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      const removeIdx = callLog.findIndex((c) => c.op === 'remove' && c.eventName === eventName);
      const addIdx = callLog.findIndex((c) => c.op === 'add' && c.eventName === eventName);
      expect(removeIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThanOrEqual(0);
      expect(removeIdx).toBeLessThan(addIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// removeClaudeCodeWiring
// ---------------------------------------------------------------------------

describe('removeClaudeCodeWiring', () => {
  let settings: ClaudeCodeWiringSettings;

  beforeEach(() => {
    settings = createMockSettings();
  });

  it('calls removeHook for each session-events entry', async () => {
    const result = await removeClaudeCodeWiring(settings, 'user');
    expect(settings.removeHook).toHaveBeenCalled();
    expect(result.removed).toBeGreaterThan(0);
  });

  it('calls removeStatusline when the target scope has a Makaio statusline without upstream', async () => {
    const settingsWithStatusline = createMockSettings({}, { type: 'command', command: 'makaio claude statusline' }, [
      {
        scope: 'user',
        path: '/home/.claude/settings.json',
        value: { type: 'command', command: 'makaio claude statusline' },
      },
    ]);
    (settingsWithStatusline.removeStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: { type: 'command', command: 'makaio claude statusline' },
      removed: true,
    });
    const result = await removeClaudeCodeWiring(settingsWithStatusline, 'user');
    expect(settingsWithStatusline.removeStatusline).toHaveBeenCalledWith({ scope: 'user' });
    expect(settingsWithStatusline.setStatusline).not.toHaveBeenCalled();
    expect(result.removed).toBeGreaterThan(0);
  });

  it('restores the original upstream command when unwiring a statusline with --upstream', async () => {
    const makaioCommand =
      'makaio claude statusline --upstream-command sh --upstream-args-json \'["-c","npx -y ccstatusline@latest"]\'';
    const settingsWithUpstream = createMockSettings({}, { type: 'command', command: makaioCommand }, [
      {
        scope: 'user',
        path: '/home/.claude/settings.json',
        value: { type: 'command', command: makaioCommand },
      },
    ]);
    (settingsWithUpstream.setStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: { type: 'command', command: makaioCommand },
      applied: { type: 'command', command: 'npx -y ccstatusline@latest' },
    });
    const result = await removeClaudeCodeWiring(settingsWithUpstream, 'user');
    expect(settingsWithUpstream.removeStatusline).not.toHaveBeenCalled();
    expect(settingsWithUpstream.setStatusline).toHaveBeenCalledWith({
      scope: 'user',
      value: { type: 'command', command: 'npx -y ccstatusline@latest' },
    });
    expect(result.removed).toBeGreaterThan(0);
  });

  it('preserves extra statusline fields like padding when restoring upstream', async () => {
    const makaioCommand =
      'makaio claude statusline --upstream-command sh --upstream-args-json \'["-c","npx -y ccstatusline@latest"]\'';
    const settingsWithPadding = createMockSettings({}, { type: 'command', command: makaioCommand }, [
      {
        scope: 'user',
        path: '/home/.claude/settings.json',
        value: { type: 'command', command: makaioCommand, padding: 0 } as { type: 'command'; command: string },
      },
    ]);
    (settingsWithPadding.setStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: { type: 'command', command: makaioCommand, padding: 0 },
      applied: { type: 'command', command: 'npx -y ccstatusline@latest', padding: 0 },
    });
    await removeClaudeCodeWiring(settingsWithPadding, 'user');
    const setCall = (settingsWithPadding.setStatusline as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { value: Record<string, unknown> },
    ];
    expect(setCall[0].value).toMatchObject({
      type: 'command',
      command: 'npx -y ccstatusline@latest',
      padding: 0,
    });
  });

  it('restores the upstream command when trailing flags follow the JSON array', async () => {
    const makaioCommand =
      'makaio claude statusline --upstream-command sh --upstream-args-json \'["-c","npx -y ccstatusline@latest"]\' --some-future-flag';
    const settingsWithTrailing = createMockSettings({}, { type: 'command', command: makaioCommand }, [
      {
        scope: 'user',
        path: '/home/.claude/settings.json',
        value: { type: 'command', command: makaioCommand },
      },
    ]);
    (settingsWithTrailing.setStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: { type: 'command', command: makaioCommand },
      applied: { type: 'command', command: 'npx -y ccstatusline@latest' },
    });
    const result = await removeClaudeCodeWiring(settingsWithTrailing, 'user');
    expect(settingsWithTrailing.setStatusline).toHaveBeenCalledWith({
      scope: 'user',
      value: { type: 'command', command: 'npx -y ccstatusline@latest' },
    });
    expect(result.removed).toBeGreaterThan(0);
  });

  it('does not call removeStatusline when no statusline is set in the target scope', async () => {
    // default mock has perScope: [] — scopeValue resolves to null, no removal
    await removeClaudeCodeWiring(settings, 'user');
    expect(settings.removeStatusline).not.toHaveBeenCalled();
  });

  it('does not call removeStatusline when the target scope statusline is not Makaio-managed', async () => {
    const settingsWithForeignStatusline = createMockSettings(
      {},
      { type: 'command', command: 'some-other-tool status' },
      [
        {
          scope: 'user',
          path: '/home/.claude/settings.json',
          value: { type: 'command', command: 'some-other-tool status' },
        },
      ],
    );
    await removeClaudeCodeWiring(settingsWithForeignStatusline, 'user');
    expect(settingsWithForeignStatusline.removeStatusline).not.toHaveBeenCalled();
  });

  it('does not call removeStatusline when project scope has Makaio statusline but user scope is empty', async () => {
    // Bug 1: effective reflects the project scope sentinel, but the target user
    // scope has no entry — removeStatusline must not be called.
    const settingsWithProjectSentinel = createMockSettings(
      {},
      { type: 'command', command: 'makaio claude statusline' },
      [
        {
          scope: 'project',
          path: '/repo/.claude/settings.json',
          value: { type: 'command', command: 'makaio claude statusline' },
        },
      ],
    );
    await removeClaudeCodeWiring(settingsWithProjectSentinel, 'user');
    expect(settingsWithProjectSentinel.removeStatusline).not.toHaveBeenCalled();
  });

  it('removes user scope Makaio statusline even when project scope overrides with a non-Makaio entry', async () => {
    // Bug 2: effective reflects the project scope non-Makaio entry, which would
    // have hidden the user scope Makaio entry under the old logic.
    const settingsWithProjectOverride = createMockSettings({}, { type: 'command', command: 'some-other-tool status' }, [
      {
        scope: 'user',
        path: '/home/.claude/settings.json',
        value: { type: 'command', command: 'makaio claude statusline' },
      },
      {
        scope: 'project',
        path: '/repo/.claude/settings.json',
        value: { type: 'command', command: 'some-other-tool status' },
      },
    ]);
    (settingsWithProjectOverride.removeStatusline as ReturnType<typeof vi.fn>).mockResolvedValue({
      previous: { type: 'command', command: 'makaio claude statusline' },
      removed: true,
    });
    const result = await removeClaudeCodeWiring(settingsWithProjectOverride, 'user');
    expect(settingsWithProjectOverride.removeStatusline).toHaveBeenCalledWith({ scope: 'user' });
    expect(result.removed).toBeGreaterThan(0);
  });

  it('passes the correct scope to removeHook', async () => {
    await removeClaudeCodeWiring(settings, 'project');
    const calls = (settings.removeHook as ReturnType<typeof vi.fn>).mock.calls as [{ scope: string }][];
    expect(calls.every((args) => args[0].scope === 'project')).toBe(true);
  });

  it('returns removed=0 when all removeHook calls return 0 and no statusline', async () => {
    (settings.removeHook as ReturnType<typeof vi.fn>).mockResolvedValue({ removed: 0 });
    const result = await removeClaudeCodeWiring(settings, 'user');
    expect(result.removed).toBe(0);
  });
});

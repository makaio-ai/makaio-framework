/**
 * Unit tests for `PostToolUse` request-mode wiring in the Claude Code wiring module.
 *
 * `PostToolUse` declares `context.append` as a response capability and is
 * non-blockable (the tool has already run), so it is wired through
 * `hook handle` with the context-only timeout
 * ({@link CONTEXT_ONLY_HOOK_HANDLE_TIMEOUT_MS}) instead of the default used by
 * the blockable `PreToolUse`. Lives beside `wiring.test.ts` to keep that file
 * within the size budget.
 */

import { DEFAULT_HOOK_HANDLE_TIMEOUT_MS } from '@makaio/subsystem-client';
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeCodeWiringSettings } from '../wiring.js';
import { applyClaudeCodeWiring, buildClaudeCodeWiringList, CONTEXT_ONLY_HOOK_HANDLE_TIMEOUT_MS } from '../wiring.js';

/** Expected installed command for `PostToolUse` with the `makaio` executable. */
const POST_TOOL_USE_COMMAND =
  'makaio --no-launch --debounce-failure hook handle claude-code PostToolUse --timeout 1000';

/** Expected installed command for `PreToolUse` with the `makaio` executable. */
const PRE_TOOL_USE_COMMAND = 'makaio --no-launch --debounce-failure hook handle claude-code PreToolUse --timeout 5000';

/**
 * Create a mock {@link ClaudeCodeWiringSettings} with no existing wiring.
 * @returns Mock settings object.
 */
function createMockSettings(): ClaudeCodeWiringSettings {
  return {
    listHooks: vi.fn().mockResolvedValue({ effective: {}, perScope: [] }),
    addHook: vi.fn().mockResolvedValue({ added: true }),
    removeHook: vi.fn().mockResolvedValue({ removed: 1 }),
    listStatusline: vi.fn().mockResolvedValue({ effective: null, perScope: [] }),
    setStatusline: vi.fn().mockResolvedValue({
      previous: null,
      applied: { type: 'command', command: 'makaio claude statusline' },
    }),
    removeStatusline: vi.fn().mockResolvedValue({ previous: null, removed: false }),
    setSkipDangerousModePermissionPrompt: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Collect the hook commands passed to `addHook`, keyed by event name.
 * @param settings - Mock settings after `applyClaudeCodeWiring` ran.
 * @returns Map from event name to installed command.
 */
function installedCommands(settings: ClaudeCodeWiringSettings): Map<string, string> {
  const calls = (settings.addHook as ReturnType<typeof vi.fn>).mock.calls as [
    { eventName: string; hook: { command: string } },
  ][];
  return new Map(calls.map(([req]) => [req.eventName, req.hook.command]));
}

describe('PostToolUse request-mode wiring', () => {
  it('pins the timeout constants the command expectations rely on', () => {
    expect(CONTEXT_ONLY_HOOK_HANDLE_TIMEOUT_MS).toBe(1000);
    expect(DEFAULT_HOOK_HANDLE_TIMEOUT_MS).toBe(5000);
  });

  it('builds the PostToolUse entry with hook handle and --timeout 1000 (context-only, non-blockable)', async () => {
    const result = await buildClaudeCodeWiringList(createMockSettings(), 'makaio');
    const postToolUse = result.entries.find((e) => e.name === 'PostToolUse');
    expect(postToolUse).toBeDefined();
    expect(postToolUse?.command).toBe(POST_TOOL_USE_COMMAND);
    expect(postToolUse?.command).not.toContain('hook received');
    expect(postToolUse?.command).not.toContain('--timeout 5000');
  });

  it('keeps the default --timeout 5000 for the blockable PreToolUse entry', async () => {
    const result = await buildClaudeCodeWiringList(createMockSettings(), 'makaio');
    const preToolUse = result.entries.find((e) => e.name === 'PreToolUse');
    expect(preToolUse?.command).toBe(PRE_TOOL_USE_COMMAND);
    expect(preToolUse?.command).not.toContain('--timeout 1000');
  });

  it('installs PostToolUse with --timeout 1000 and PreToolUse with --timeout 5000 on apply', async () => {
    const settings = createMockSettings();
    await applyClaudeCodeWiring(settings, 'user', 'makaio');
    const commands = installedCommands(settings);
    expect(commands.get('PostToolUse')).toBe(POST_TOOL_USE_COMMAND);
    expect(commands.get('PreToolUse')).toBe(PRE_TOOL_USE_COMMAND);
  });

  it('migrates a stale hook received PostToolUse entry to the hook handle --timeout 1000 form', async () => {
    const callLog: Array<{ op: 'remove' | 'add'; eventName: string; detail: string }> = [];
    const settings: ClaudeCodeWiringSettings = {
      ...createMockSettings(),
      listHooks: vi.fn().mockResolvedValue({
        effective: {},
        perScope: [
          {
            scope: 'user' as const,
            path: '/home/.claude/settings.json',
            events: {
              PostToolUse: [
                { hooks: [{ type: 'command' as const, command: 'makaio hook received claude-code PostToolUse' }] },
              ],
            },
          },
        ],
      }),
      addHook: vi.fn().mockImplementation(async (req: { eventName: string; hook: { command: string } }) => {
        callLog.push({ op: 'add', eventName: req.eventName, detail: req.hook.command });
        return { added: true };
      }),
      removeHook: vi.fn().mockImplementation(async (req: { eventName: string; match: { commandContains: string } }) => {
        callLog.push({ op: 'remove', eventName: req.eventName, detail: req.match.commandContains });
        return { removed: 1 };
      }),
    };

    await applyClaudeCodeWiring(settings, 'user', 'makaio');

    const removeEntry = callLog.find((e) => e.op === 'remove' && e.eventName === 'PostToolUse');
    expect(removeEntry?.detail).toBe('hook received claude-code PostToolUse');
    const addEntry = callLog.find((e) => e.op === 'add' && e.eventName === 'PostToolUse');
    expect(addEntry?.detail).toBe(POST_TOOL_USE_COMMAND);
    expect(callLog.indexOf(removeEntry!)).toBeLessThan(callLog.indexOf(addEntry!));
  });
});

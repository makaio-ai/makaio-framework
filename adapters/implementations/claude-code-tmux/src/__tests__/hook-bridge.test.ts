import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CLAUDE_CODE_HOOK_PRE_TOOL_USE } from '@makaio/client-claude-code/runtime';
import { startHookBridge, type HookBridgeHandle } from '../test/hook-bridge.js';

describe('test hook bridge', () => {
  let bridge: HookBridgeHandle | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('denies PreToolUse when agent context cannot be correlated', async () => {
    bridge = await startHookBridge();

    const response = await fetch(`http://127.0.0.1:${bridge.port}/hook/${CLAUDE_CODE_HOOK_PRE_TOOL_USE}`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'missing-session',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'echo unsafe' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: CLAUDE_CODE_HOOK_PRE_TOOL_USE,
        permissionDecision: 'deny',
        permissionDecisionReason: 'Missing agent context for PreToolUse approval',
      },
    });
  });
});

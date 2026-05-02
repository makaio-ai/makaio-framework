import { describe, expect, it, vi } from 'vitest';
import type { BeforeToolCallContext } from '@mariozechner/pi-agent-core';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { createPiBeforeToolCallHook } from '../tool-handling.js';

function createBeforeToolCallContext(args: Record<string, unknown> = { path: 'original.md' }): BeforeToolCallContext {
  const toolCallArgs = { ...args };
  const executionArgs = { ...args };
  return {
    toolCall: {
      id: 'tool-call-1',
      name: 'read_file',
      type: 'toolCall',
      arguments: toolCallArgs,
    },
    args: executionArgs,
    assistantMessage: {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'toolUse',
      timestamp: 0,
    },
    context: {
      systemPrompt: '',
      messages: [],
      tools: [],
    },
  };
}

describe('createPiBeforeToolCallHook', () => {
  it('stores approval-rewritten input for tools that can apply it', async () => {
    const requestApproval = vi.fn<() => Promise<AgentToolApproveResponse>>().mockResolvedValue({
      action: 'allow',
      updatedInput: { path: 'approved.md' },
    });
    const onApprovedInputUpdate = vi.fn(() => true);
    const hook = createPiBeforeToolCallHook(requestApproval, { onApprovedInputUpdate });

    const context = createBeforeToolCallContext();
    const result = await hook(context);

    expect(result).toBeUndefined();
    expect(onApprovedInputUpdate).toHaveBeenCalledWith('tool-call-1', 'read_file', { path: 'approved.md' });
    expect(context.args).toEqual({ path: 'approved.md' });
    expect(context.toolCall.arguments).toEqual({ path: 'approved.md' });
  });

  it('applies approval input rewrites to Pi native execution args', async () => {
    const requestApproval = vi.fn<() => Promise<AgentToolApproveResponse>>().mockResolvedValue({
      action: 'allow',
      updatedInput: { path: 'approved.md' },
    });
    const context = createBeforeToolCallContext();
    const hook = createPiBeforeToolCallHook(requestApproval);

    const result = await hook(context);

    expect(result).toBeUndefined();
    expect(context.args).toEqual({ path: 'approved.md' });
    expect(context.toolCall.arguments).toEqual({ path: 'approved.md' });
  });

  it('marks hard-denied approvals as abort requests', async () => {
    const requestApproval = vi.fn<() => Promise<AgentToolApproveResponse>>().mockResolvedValue({
      action: 'deny',
      message: 'Denied by policy.',
      shouldAbort: true,
    });
    const onAbortRequested = vi.fn();
    const hook = createPiBeforeToolCallHook(requestApproval, { onAbortRequested });

    const result = await hook(createBeforeToolCallContext());

    expect(result).toEqual({ block: true, reason: 'Denied by policy.' });
    expect(onAbortRequested).toHaveBeenCalledWith('read_file', 'Denied by policy.');
  });
});

import { afterEach, describe, expect, it, vi } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { registerToolApprovalHandler } from '../../src/shared/permissions.js';

function approvePayload(agentId: string, toolName: string, toolCallId: string, args?: Record<string, unknown>) {
  return {
    agentId,
    adapterId: 'a-1',
    adapterName: 'test',
    adapterSessionId: 'as-1',
    sessionId: 'session-1',
    toolName,
    toolCallId,
    ...(args ? { args } : {}),
  };
}

describe('registerToolApprovalHandler', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('responds with allow when canUseTool returns allow', async () => {
    const canUseTool = vi.fn().mockReturnValue({ behavior: 'allow' as const });
    cleanups.push(registerToolApprovalHandler(MakaioBus, 'agent-1', canUseTool));

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      approvePayload('agent-1', 'read', 'tc-1', { path: '/foo' }),
    );

    expect(result.action).toBe('allow');
    expect(canUseTool).toHaveBeenCalledWith('read', { path: '/foo' });
  });

  it('responds with deny when canUseTool returns deny', async () => {
    const canUseTool = vi.fn().mockReturnValue({ behavior: 'deny' as const, message: 'Not allowed' });
    cleanups.push(registerToolApprovalHandler(MakaioBus, 'agent-2', canUseTool));

    const result = await MakaioBus.request(AgentSubjects.toolApprove, approvePayload('agent-2', 'rm', 'tc-2'));

    expect(result.action).toBe('deny');
    expect(result).toHaveProperty('message', 'Not allowed');
  });

  it('passes updatedInput through on allow', async () => {
    const canUseTool = vi.fn().mockReturnValue({
      behavior: 'allow' as const,
      updatedInput: { sanitized: true },
    });
    cleanups.push(registerToolApprovalHandler(MakaioBus, 'agent-3', canUseTool));

    const result = await MakaioBus.request(AgentSubjects.toolApprove, approvePayload('agent-3', 'write', 'tc-3'));

    expect(result.action).toBe('allow');
    expect(result).toHaveProperty('updatedInput', { sanitized: true });
  });

  it('sets shouldAbort from interrupt flag', async () => {
    const canUseTool = vi.fn().mockReturnValue({
      behavior: 'deny' as const,
      message: 'Abort!',
      interrupt: true,
    });
    cleanups.push(registerToolApprovalHandler(MakaioBus, 'agent-4', canUseTool));

    const result = await MakaioBus.request(AgentSubjects.toolApprove, approvePayload('agent-4', 'exec', 'tc-4'));

    expect(result.action).toBe('deny');
    expect(result).toHaveProperty('shouldAbort', true);
  });

  it('returns cleanup function that unregisters handler', async () => {
    const canUseTool = vi.fn().mockReturnValue({ behavior: 'allow' as const });
    const cleanup = registerToolApprovalHandler(MakaioBus, 'agent-5', canUseTool);

    cleanup();

    await expect(
      MakaioBus.request(AgentSubjects.toolApprove, approvePayload('agent-5', 'read', 'tc-5')),
    ).rejects.toThrow();
    expect(canUseTool).not.toHaveBeenCalled();
  });
});

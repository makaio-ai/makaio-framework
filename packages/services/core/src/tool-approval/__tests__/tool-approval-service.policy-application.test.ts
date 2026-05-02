/**
 * ToolApprovalService policy application tests.
 *
 * Tests how resolved policies are applied (full-access, reject, always-ask).
 * Following the lessons-learned: tests use real bus handlers, not mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ApprovalSubjects } from '@makaio/contracts';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  TEST_ADAPTER_ID,
  TEST_ADAPTER_NAME,
  TEST_ADAPTER_SESSION_ID,
  TEST_AGENT_ID,
  createToolApprovePayload,
  registerDefaultHarnessHandler,
  registerAgentStub,
} from './test-utils.js';

describe('ToolApprovalService - Policy Application', () => {
  let service: ToolApprovalService;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new ToolApprovalService(MakaioBus);
    cleanups.push(registerDefaultHarnessHandler());
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('should auto-allow for full-access policy', async () => {
    registerAgentStub(cleanups, { personaId: 'persona-1' });
    let enrichedPolicyCallCount = 0;

    // Stub the host-tier RPC: persona has full-access policy.
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        enrichedPolicyCallCount += 1;
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('allow');
    expect(enrichedPolicyCallCount).toBe(1);
  });

  it('should auto-deny for reject policy with message', async () => {
    registerAgentStub(cleanups, { profileId: 'profile-1' });
    let enrichedPolicyCallCount = 0;

    // Stub the host-tier RPC: profile has reject policy.
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        enrichedPolicyCallCount += 1;
        ctx.setResult({ action: 'deny' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('Tool use rejected by approval policy');
      expect(result.shouldAbort).toBe(false);
    }
    expect(enrichedPolicyCallCount).toBe(1);
  });

  it('should request approval and allow for always-ask with allow response', async () => {
    registerAgentStub(cleanups);

    // Register approval handler that allows
    let approvalRequest: unknown;
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, (ctx) => {
        approvalRequest = ctx.payload;
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'bash',
        args: { command: 'ls -la' },
      }),
    );

    expect(result.action).toBe('allow');
    expect(approvalRequest).toMatchObject({
      toolName: 'bash',
      args: { command: 'ls -la' },
      agentId: 'test-agent-1',
      adapterName: 'test-adapter',
      riskLevel: 'neutral',
    });
    expect((approvalRequest as { requestId: string }).requestId).toContain('apr_');
  });

  it('uses agent adapterName in approval payload when it differs from incoming payload', async () => {
    registerAgentStub(cleanups, { adapterName: 'resolved-adapter' });

    let approvalRequest: unknown;
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, (ctx) => {
        approvalRequest = ctx.payload;
        ctx.setResult({ action: 'allow' });
      }),
    );

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({ adapterName: 'incoming-adapter' }),
    );

    expect(result.action).toBe('allow');
    expect(approvalRequest).toMatchObject({
      adapterName: 'resolved-adapter',
    });
  });

  it('should request approval and deny for always-ask with deny response', async () => {
    registerAgentStub(cleanups);

    // Register approval handler that denies
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, (ctx) => {
        ctx.setResult({ action: 'deny' });
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('User denied tool execution');
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('should deny for always-ask when no approval handler is available', async () => {
    registerAgentStub(cleanups);

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('No approval handler available');
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('should deny for always-ask when approval handler throws', async () => {
    registerAgentStub(cleanups);

    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, () => {
        throw new Error('approval transport unavailable');
      }),
    );

    const result = await MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('Tool approval request failed');
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('should deny with session-closed message when agent session closes during approval wait', async () => {
    registerAgentStub(cleanups);

    let resolveApproval!: () => void;
    // Register an approval handler that stalls until manually released — simulates a pending UI prompt
    cleanups.push(
      MakaioBus.on(ApprovalSubjects.request, async (ctx) => {
        await new Promise<void>((resolve) => {
          resolveApproval = resolve;
        });
        ctx.setResult({ action: 'allow' });
      }),
    );

    // Trigger the tool approval request; the approval handler will stall
    const approvalPromise = MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload());

    // Wait until the handler has started and resolveApproval is assigned
    await vi.waitFor(() => {
      if (!resolveApproval) throw new Error('handler not yet started');
    });

    // Emit session closed for the matching agent — this should abort the pending approval
    MakaioBus.emit(AgentSubjects.session.closed, {
      agentId: TEST_AGENT_ID,
      adapterId: TEST_ADAPTER_ID,
      adapterName: TEST_ADAPTER_NAME,
      adapterSessionId: TEST_ADAPTER_SESSION_ID,
    });

    const result = await approvalPromise;

    // Release the stalled handler to avoid dangling promises
    resolveApproval();

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('Approval cancelled — agent session closed');
      expect(result.shouldAbort).toBe(false);
    }
  });
});

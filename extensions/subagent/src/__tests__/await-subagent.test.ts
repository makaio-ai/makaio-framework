import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { awaitSubagentTool } from '../tools/parent/index.js';
import { createMockBus, createParentContext } from './test-helpers.js';

describe('await_subagent tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('returns immediately for completed subagent', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => ({
      status: 'completed',
      result: 'Done!',
    }));

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('completed');
      expect(result.data.result).toBe('Done!');
    }
  });

  it('returns immediately for failed subagent', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => ({
      status: 'failed',
      error: 'Error occurred',
    }));

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('failed');
      expect(result.data.error).toBe('Error occurred');
    }
  });

  it('returns immediately for cancelled subagent', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => ({
      status: 'cancelled',
    }));

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('cancelled');
    }
  });

  it('returns immediately for waiting_input subagent', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => ({
      status: 'waiting_input',
      pendingRequest: {
        messageId: 'msg-1',
        question: 'What color?',
      },
    }));

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('waiting_input');
      expect(result.data.pendingRequest?.messageId).toBe('msg-1');
    }
  });

  it('returns timeout status when await times out', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => ({
      status: 'timeout',
    }));

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1', timeoutMs: 100 }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('timeout');
    }
  });

  it('returns error for unknown subagent', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'unknown' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.NOT_FOUND);
    }
  });

  it('passes timeout to service', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.await.subject, (payload) => {
      capturedPayload = payload;
      return { status: 'timeout' };
    });

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    await tool.execute({ subagentId: 'sub-1', timeoutMs: 5000 }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      timeoutMs: 5000,
    });
  });

  it('opts out of the bus envelope timeout so the service owns the await deadline', async () => {
    mockBus.onRequest(SubagentSubjects.await.subject, () => ({
      status: 'completed',
      result: 'Done!',
    }));

    const tool = awaitSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    await tool.execute({ subagentId: 'sub-1', timeoutMs: 120_000 }, context);

    // Without `timeout: 0`, the bus request envelope defaults to 60s and
    // kills every await longer than that regardless of the requested
    // timeoutMs (the semantic deadline enforced by the SubagentService).
    expect(vi.mocked(mockBus.bus.request)).toHaveBeenCalledWith(
      SubagentSubjects.await,
      { subagentId: 'sub-1', timeoutMs: 120_000 },
      { timeout: 0 },
    );
  });

  it('requires bus in context', async () => {
    const tool = awaitSubagentTool();
    const noBusContext = createParentContext({ bus: mockBus.bus });
    delete (noBusContext as { bus?: unknown }).bus;

    const result = await tool.execute({ subagentId: 'sub-1' }, noBusContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('Bus not available');
    }
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { checkSubagentTool } from '../tools/parent/index.js';
import { createMockBus, createParentContext } from './test-helpers.js';

describe('check_subagent tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('returns status for running subagent', async () => {
    mockBus.onRequest(SubagentSubjects.getStatus.subject, () => ({
      status: 'running',
      progress: [],
    }));

    const tool = checkSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('running');
      expect(result.data.progress).toEqual([]);
    }
  });

  it('returns pending request when waiting for input', async () => {
    mockBus.onRequest(SubagentSubjects.getStatus.subject, () => ({
      status: 'waiting_input',
      progress: [],
      pendingRequest: {
        messageId: 'msg-1',
        question: 'What color?',
        context: 'Choose a color',
      },
    }));

    const tool = checkSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('waiting_input');
      expect(result.data.pendingRequest).toEqual({
        messageId: 'msg-1',
        question: 'What color?',
        context: 'Choose a color',
      });
    }
  });

  it('returns progress updates', async () => {
    mockBus.onRequest(SubagentSubjects.getStatus.subject, () => ({
      status: 'running',
      progress: ['Step 1 done', 'Step 2 done'],
    }));

    const tool = checkSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.progress).toEqual(['Step 1 done', 'Step 2 done']);
    }
  });

  it('returns result for completed subagent', async () => {
    mockBus.onRequest(SubagentSubjects.getStatus.subject, () => ({
      status: 'completed',
      progress: [],
      result: 'Task completed successfully',
    }));

    const tool = checkSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('completed');
      expect(result.data.result).toBe('Task completed successfully');
    }
  });

  it('returns error for failed subagent', async () => {
    mockBus.onRequest(SubagentSubjects.getStatus.subject, () => ({
      status: 'failed',
      progress: [],
      error: 'Something went wrong',
    }));

    const tool = checkSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('failed');
      expect(result.data.error).toBe('Something went wrong');
    }
  });

  it('returns error for unknown subagent', async () => {
    mockBus.onRequest(SubagentSubjects.getStatus.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = checkSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'unknown' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.NOT_FOUND);
    }
  });

  it('requires bus in context', async () => {
    const tool = checkSubagentTool();
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

import { describe, it, expect, beforeEach } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { completeTaskTool } from '../tools/child/index.js';
import { createMockBus, createChildContext } from './test-helpers.js';

describe('complete_task tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('completes task with result', async () => {
    mockBus.onRequest(SubagentSubjects.completeTask.subject, () => ({
      completed: true,
    }));

    const tool = completeTaskTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    const result = await tool.execute({ result: 'Task completed successfully' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.completed).toBe(true);
    }
  });

  it('completes task with result and summary', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.completeTask.subject, (payload) => {
      capturedPayload = payload;
      return { completed: true };
    });

    const tool = completeTaskTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    await tool.execute(
      {
        result: 'Created 3 new files',
        summary: 'Implemented the feature as requested',
      },
      context,
    );

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      result: 'Created 3 new files',
      summary: 'Implemented the feature as requested',
    });
  });

  it('returns error when already completed', async () => {
    mockBus.onRequest(SubagentSubjects.completeTask.subject, () => {
      throw new Error('ALREADY_TERMINAL: Subagent already in terminal state');
    });

    const tool = completeTaskTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    const result = await tool.execute({ result: 'Try to complete' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('ALREADY_TERMINAL');
    }
  });

  it('returns error when not running as subagent', async () => {
    const tool = completeTaskTool();
    const nonSubagentContext = {
      ...createMakaioContext({ cwd: '/test' }),
      sessionId: 'parent-1',
      subagentDepth: 0,
      bus: mockBus.bus,
    };

    const result = await tool.execute({ result: 'Test' }, nonSubagentContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toBe('Not running as a subagent');
    }
  });

  it('returns error when service reports not found', async () => {
    mockBus.onRequest(SubagentSubjects.completeTask.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = completeTaskTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'unknown-subagent' });
    const result = await tool.execute({ result: 'Test' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
    }
  });

  it('requires bus in context', async () => {
    const tool = completeTaskTool();
    const noBusContext = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    delete (noBusContext as { bus?: unknown }).bus;

    const result = await tool.execute({ result: 'Test' }, noBusContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('Bus not available');
    }
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { reportProgressTool } from '../tools/child/index.js';
import { createMockBus, createChildContext } from './test-helpers.js';

describe('report_progress tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('reports progress without percentage', async () => {
    mockBus.onRequest(SubagentSubjects.reportProgress.subject, () => ({
      reported: true,
    }));

    const tool = reportProgressTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    const result = await tool.execute({ update: 'Step 1 done' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reported).toBe(true);
    }
  });

  it('reports progress with percentage', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.reportProgress.subject, (payload) => {
      capturedPayload = payload;
      return { reported: true };
    });

    const tool = reportProgressTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    await tool.execute({ update: 'Halfway there', percentComplete: 50 }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      update: 'Halfway there',
      percentComplete: 50,
    });
  });

  it('reports progress with 0 percent', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.reportProgress.subject, (payload) => {
      capturedPayload = payload;
      return { reported: true };
    });

    const tool = reportProgressTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    await tool.execute({ update: 'Starting', percentComplete: 0 }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      update: 'Starting',
      percentComplete: 0,
    });
  });

  it('reports progress with 100 percent', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.reportProgress.subject, (payload) => {
      capturedPayload = payload;
      return { reported: true };
    });

    const tool = reportProgressTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    await tool.execute({ update: 'Complete', percentComplete: 100 }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      update: 'Complete',
      percentComplete: 100,
    });
  });

  it('returns error when not running as subagent', async () => {
    const tool = reportProgressTool();
    const nonSubagentContext = {
      ...createMakaioContext({ cwd: '/test' }),
      sessionId: 'parent-1',
      subagentDepth: 0,
      bus: mockBus.bus,
    };

    const result = await tool.execute({ update: 'Test' }, nonSubagentContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toBe('Not running as a subagent');
    }
  });

  it('returns error when service reports failure', async () => {
    mockBus.onRequest(SubagentSubjects.reportProgress.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = reportProgressTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'unknown-subagent' });
    const result = await tool.execute({ update: 'Test' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
    }
  });

  it('requires bus in context', async () => {
    const tool = reportProgressTool();
    const noBusContext = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    delete (noBusContext as { bus?: unknown }).bus;

    const result = await tool.execute({ update: 'Test' }, noBusContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('Bus not available');
    }
  });
});

import { describe, it, expect, beforeEach } from 'bun:test';
import { createMakaioContext } from '@makaio/core';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { requestInputTool } from '../tools/child/index.js';
import { createMockBus, createChildContext } from './test-helpers.js';

describe('request_input tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('receives response from parent', async () => {
    mockBus.onRequest(SubagentSubjects.requestInput.subject, () => ({
      responded: true,
      response: 'Blue',
      timedOut: false,
    }));

    const tool = requestInputTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    const result = await tool.execute({ question: 'What color?', context: 'Choose wisely' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responded).toBe(true);
      expect(result.data.response).toBe('Blue');
      expect(result.data.timedOut).toBe(false);
    }
  });

  it('returns timeout when parent does not respond', async () => {
    mockBus.onRequest(SubagentSubjects.requestInput.subject, () => ({
      responded: false,
      timedOut: true,
    }));

    const tool = requestInputTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    const result = await tool.execute({ question: 'What color?', timeoutMs: 1000 }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responded).toBe(false);
      expect(result.data.response).toBeUndefined();
      expect(result.data.timedOut).toBe(true);
    }
  });

  it('passes correct payload to service', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.requestInput.subject, (payload) => {
      capturedPayload = payload;
      return { responded: true, response: 'Answer', timedOut: false };
    });

    const tool = requestInputTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    await tool.execute({ question: 'What color?', context: 'Choose wisely', timeoutMs: 5000 }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      question: 'What color?',
      context: 'Choose wisely',
      timeoutMs: 5000,
    });
  });

  it('returns error when service reports pending request', async () => {
    mockBus.onRequest(SubagentSubjects.requestInput.subject, () => {
      throw new Error('REQUEST_PENDING: Request already pending');
    });

    const tool = requestInputTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    const result = await tool.execute({ question: 'Second question?' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('REQUEST_PENDING');
    }
  });

  it('returns error when not running as subagent', async () => {
    const tool = requestInputTool();
    const nonSubagentContext = {
      ...createMakaioContext({ cwd: '/test' }),
      sessionId: 'parent-1',
      subagentDepth: 0,
      bus: mockBus.bus,
    };

    const result = await tool.execute({ question: 'What color?' }, nonSubagentContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toBe('Not running as a subagent');
    }
  });

  it('returns error when service reports not found', async () => {
    mockBus.onRequest(SubagentSubjects.requestInput.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = requestInputTool();
    const context = createChildContext({ bus: mockBus.bus, subagentId: 'unknown-subagent' });
    const result = await tool.execute({ question: 'What color?' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
    }
  });

  it('requires bus in context', async () => {
    const tool = requestInputTool();
    const noBusContext = createChildContext({ bus: mockBus.bus, subagentId: 'sub-1' });
    delete (noBusContext as { bus?: unknown }).bus;

    const result = await tool.execute({ question: 'What color?' }, noBusContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('Bus not available');
    }
  });
});

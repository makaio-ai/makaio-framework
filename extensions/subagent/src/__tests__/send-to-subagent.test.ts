import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { sendToSubagentTool } from '../tools/parent/index.js';
import { createMockBus, createParentContext } from './test-helpers.js';

describe('send_to_subagent tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('sends message to subagent', async () => {
    mockBus.onRequest(SubagentSubjects.send.subject, () => ({
      sent: true,
      resolvedPending: false,
    }));

    const tool = sendToSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1', content: 'Hello child' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sent).toBe(true);
      expect(result.data.resolvedPending).toBe(false);
    }
  });

  it('resolves pending request when inResponseTo matches', async () => {
    mockBus.onRequest(SubagentSubjects.send.subject, () => ({
      sent: true,
      resolvedPending: true,
    }));

    const tool = sendToSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1', content: 'Blue', inResponseTo: 'msg-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sent).toBe(true);
      expect(result.data.resolvedPending).toBe(true);
    }
  });

  it('returns error for unknown subagent', async () => {
    mockBus.onRequest(SubagentSubjects.send.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = sendToSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'unknown', content: 'Message' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.NOT_FOUND);
    }
  });

  it('passes correct payload to service', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.send.subject, (payload) => {
      capturedPayload = payload;
      return { sent: true, resolvedPending: false };
    });

    const tool = sendToSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    await tool.execute({ subagentId: 'sub-1', content: 'Test message', inResponseTo: 'req-1' }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
      content: 'Test message',
      inResponseTo: 'req-1',
    });
  });

  it('requires bus in context', async () => {
    const tool = sendToSubagentTool();
    const noBusContext = createParentContext({ bus: mockBus.bus });
    delete (noBusContext as { bus?: unknown }).bus;

    const result = await tool.execute({ subagentId: 'sub-1', content: 'Message' }, noBusContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('Bus not available');
    }
  });
});

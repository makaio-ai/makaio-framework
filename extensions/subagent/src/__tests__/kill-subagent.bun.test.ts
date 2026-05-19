import { describe, it, expect, beforeEach } from 'bun:test';
import { SubagentErrorCode, SubagentSubjects } from '@makaio/contracts';
import { killSubagentTool } from '../tools/parent/index.js';
import { createMockBus, createParentContext } from './test-helpers.js';

describe('kill_subagent tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('kills a running subagent', async () => {
    mockBus.onRequest(SubagentSubjects.kill.subject, () => ({
      killed: true,
    }));

    const tool = killSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1', reason: 'No longer needed' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.killed).toBe(true);
    }
  });

  it('returns killed=false for already terminal subagent', async () => {
    mockBus.onRequest(SubagentSubjects.kill.subject, () => ({
      killed: false,
    }));

    const tool = killSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'sub-1' }, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.killed).toBe(false);
    }
  });

  it('returns error for unknown subagent', async () => {
    mockBus.onRequest(SubagentSubjects.kill.subject, () => {
      throw new Error('Subagent not found');
    });

    const tool = killSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute({ subagentId: 'unknown' }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.NOT_FOUND);
    }
  });

  it('passes subagentId to service', async () => {
    let capturedPayload: unknown;
    mockBus.onRequest(SubagentSubjects.kill.subject, (payload) => {
      capturedPayload = payload;
      return { killed: true };
    });

    const tool = killSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    await tool.execute({ subagentId: 'sub-1' }, context);

    expect(capturedPayload).toEqual({
      subagentId: 'sub-1',
    });
  });

  it('requires bus in context', async () => {
    const tool = killSubagentTool();
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

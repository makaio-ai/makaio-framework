import { describe, it, expect, beforeEach } from 'bun:test';
import { createMakaioContext } from '@makaio/core';
import { SubagentErrorCode, SubagentSubjects, type SpawnSubagentRpcRequest } from '@makaio/contracts';
import { spawnSubagentTool, SpawnSubagentInputSchema } from '../tools/parent/index.js';
import { spawnInput, createMockBus, createParentContext } from './test-helpers.js';

describe('spawn_subagent tool', () => {
  let mockBus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    mockBus = createMockBus();
  });

  it('spawns a subagent and returns IDs', async () => {
    mockBus.onRequest(SubagentSubjects.spawn.subject, (req) => {
      const payload = req as SpawnSubagentRpcRequest;
      return { subagentId: `sub-${payload.parentSessionId}`, status: 'spawning' as const };
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute(spawnInput({ task: 'Test task' }), context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagentId).toBe('sub-parent-session-1');
      expect(result.data.status).toBe('spawning');
    }
  });

  it('passes correct depth to service', async () => {
    let capturedRequest: SpawnSubagentRpcRequest | undefined;
    mockBus.onRequest(SubagentSubjects.spawn.subject, (req) => {
      capturedRequest = req as SpawnSubagentRpcRequest;
      return { subagentId: 'sub-1', status: 'spawning' as const };
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus, subagentDepth: 2 });
    await tool.execute(spawnInput({ task: 'Test task' }), context);

    expect(capturedRequest?.depth).toBe(3); // depth + 1
  });

  it('returns error when service rejects spawn (depth exceeded)', async () => {
    mockBus.onRequest(SubagentSubjects.spawn.subject, () => {
      throw new Error('DEPTH_EXCEEDED: Maximum depth exceeded');
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus, subagentDepth: 3 });
    const result = await tool.execute(spawnInput({ task: 'Test task' }), context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('DEPTH_EXCEEDED');
    }
  });

  it('returns error when service rejects spawn (session limit)', async () => {
    mockBus.onRequest(SubagentSubjects.spawn.subject, () => {
      throw new Error('SESSION_LIMIT: Session limit exceeded');
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute(spawnInput({ task: 'Test task' }), context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('SESSION_LIMIT');
    }
  });

  it('returns error when service rejects spawn (global limit)', async () => {
    mockBus.onRequest(SubagentSubjects.spawn.subject, () => {
      throw new Error('GLOBAL_LIMIT: Global limit exceeded');
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute(spawnInput({ task: 'Test task' }), context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('GLOBAL_LIMIT');
    }
  });

  it('returns error when service rejects spawn (adapter not allowed)', async () => {
    mockBus.onRequest(SubagentSubjects.spawn.subject, () => {
      throw new Error('ADAPTER_NOT_ALLOWED: Adapter not allowed');
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute(spawnInput({ task: 'Test task', adapterName: 'not-allowed' }), context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('ADAPTER_NOT_ALLOWED');
    }
  });

  it('returns error when service rejects spawn (model not allowed)', async () => {
    mockBus.onRequest(SubagentSubjects.spawn.subject, () => {
      throw new Error('MODEL_NOT_ALLOWED: Model not allowed');
    });

    const tool = spawnSubagentTool();
    const context = createParentContext({ bus: mockBus.bus });
    const result = await tool.execute(spawnInput({ task: 'Test task', model: 'not-allowed' }), context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('MODEL_NOT_ALLOWED');
    }
  });

  it('requires session ID in context', async () => {
    const tool = spawnSubagentTool();
    const noSessionContext = {
      ...createMakaioContext({ cwd: '/test' }),
      subagentDepth: 0,
      bus: mockBus.bus,
    };

    const result = await tool.execute(spawnInput({ task: 'Test task' }), noSessionContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('no session ID');
    }
  });

  it('requires bus in context', async () => {
    const tool = spawnSubagentTool();
    const noBusContext = {
      ...createMakaioContext({ cwd: '/test' }),
      sessionId: 'parent-session-1',
      subagentDepth: 0,
    };

    const result = await tool.execute(spawnInput({ task: 'Test task' }), noBusContext);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(SubagentErrorCode.INVALID_STATE);
      expect(result.error.message).toContain('Bus not available');
    }
  });
});

describe('SpawnSubagentInputSchema - workstreamId field', () => {
  it('accepts workstreamId when provided', () => {
    const parsed = SpawnSubagentInputSchema.parse({
      task: 'Test task',
      workstreamId: 'ws-123',
    });

    expect(parsed.workstreamId).toBe('ws-123');
  });

  it('sets workstreamId to undefined when not provided', () => {
    const parsed = SpawnSubagentInputSchema.parse({ task: 'Test task' });

    expect(parsed.workstreamId).toBeUndefined();
  });

  it('rejects empty workstreamId', () => {
    expect(() => SpawnSubagentInputSchema.parse({ task: 'Test task', workstreamId: '' })).toThrow();
  });
});

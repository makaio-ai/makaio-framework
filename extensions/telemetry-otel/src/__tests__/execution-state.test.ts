import { describe, expect, it } from 'vitest';
import { mergeExecutionToolStart, toolCorrelationKey } from '../collector/execution-state.js';
import { mergeRetainedToolLifecycle } from '../collector/standalone-session-traces.js';
import type { BufferedToolCall, OpenExecution } from '../collector/types.js';

describe('execution tool state', () => {
  it('builds unambiguous deterministic keys for arbitrary identifiers', () => {
    const keys = [
      toolCorrelationKey(undefined, 'call'),
      toolCorrelationKey('unknown', 'call'),
      toolCorrelationKey(undefined, 'a:b'),
      toolCorrelationKey('unknown:a', 'b'),
    ];

    expect(new Set(keys).size).toBe(keys.length);
    expect(toolCorrelationKey('session:a', 'call:b')).toBe(toolCorrelationKey('session:a', 'call:b'));
  });

  it('does not move a tool start later when duplicate starts arrive out of order', () => {
    const execution = openExecution();
    mergeExecutionToolStart(execution, tool({ startedAt: 1_000 }));
    mergeExecutionToolStart(execution, tool({ startedAt: 1_500 }));

    expect([...execution.pendingTools.values()][0]?.startedAt).toBe(1_000);
  });

  it('keeps defined success metadata when equal terminal timestamps are merged', () => {
    const retained = tool({ endedAt: 1_500, success: undefined });
    const current = tool({ endedAt: 1_500, success: true });

    expect(mergeRetainedToolLifecycle(retained, current)).toMatchObject({ endedAt: 1_500, success: true });
  });
});

function openExecution(): OpenExecution {
  return {
    executionId: 'wfx-tool-state',
    workflowId: 'workflow-tool-state',
    startedAt: 500,
    frames: new Map(),
    pendingUsage: [],
    pendingTools: new Map(),
    sessionFrameMap: new Map(),
    usageSequence: 0,
  };
}

function tool(overrides: Partial<BufferedToolCall> = {}): BufferedToolCall {
  return {
    sessionId: 'session-tool-state',
    toolName: 'read',
    toolCallId: 'call-tool-state',
    startedAt: 1_000,
    ingestedAt: 1_000,
    endedAt: undefined,
    success: undefined,
    ...overrides,
  };
}

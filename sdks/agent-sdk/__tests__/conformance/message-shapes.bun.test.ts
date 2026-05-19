/**
 * Conformance tests: message-shape snapshots for mapBusEventToSdkMessage().
 *
 * Known bus event payloads are passed through the mapping function and their
 * output shapes are captured as snapshots. This guards against accidental
 * structural regressions to the wire format consumed by SDK callers.
 *
 * Each snapshot covers one logical event type. Monotonically increasing fields
 * (duration_ms, startTime) are replaced with stable sentinels before
 * snapshotting so the suite is deterministic.
 */

import { describe, expect, it } from 'bun:test';
import { createAccumulatorState, mapBusEventToSdkMessage } from '../../src/shared/messages.js';
import type { SDKResultMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Shared fixture payload fields
// ---------------------------------------------------------------------------

const BASE = {
  agentId: 'a1',
  adapterId: 'ad1',
  adapterName: 'test',
  adapterSessionId: 'as1',
  sessionId: 's1',
  messageId: 'm1',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `duration_ms` field from an SDKResultMessage before snapshotting
 * so the assertion is deterministic regardless of wall-clock timing.
 * @param msg - The result message produced by mapBusEventToSdkMessage.
 * @returns A copy of the message with `duration_ms` replaced by a sentinel.
 */
function normaliseResultMessage(
  msg: SDKResultMessage,
): Omit<SDKResultMessage, 'duration_ms'> & { duration_ms: number } {
  return { ...msg, duration_ms: 0 };
}

// ---------------------------------------------------------------------------
// agent.started → SDKSystemMessage (init)
// ---------------------------------------------------------------------------

describe('agent.started maps to system init message', () => {
  it('produces an SDKSystemMessage with subtype "init"', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage('agent.started', { ...BASE, model: 'sonnet', cwd: '/tmp' }, state);
    expect(result).toMatchSnapshot();
  });

  it('uses the model and cwd from the payload', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.started',
      { ...BASE, model: 'opus', cwd: '/workspace/project' },
      state,
    );
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// agent.message_delta → SDKAssistantMessage (text block)
// ---------------------------------------------------------------------------

describe('agent.message_delta maps to assistant text message', () => {
  it('produces a text ContentBlock inside an assistant message', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage('agent.message_delta', { ...BASE, text: 'Hello, world!' }, state);
    expect(result).toMatchSnapshot();
  });

  it('propagates an empty text delta', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage('agent.message_delta', { ...BASE, text: '' }, state);
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// agent.reasoning_delta → SDKAssistantMessage (thinking block)
// ---------------------------------------------------------------------------

describe('agent.reasoning_delta maps to assistant thinking message', () => {
  it('produces a thinking ContentBlock inside an assistant message', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.reasoning_delta',
      { ...BASE, content: 'Let me reason about this...' },
      state,
    );
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// agent.tool.use → SDKAssistantMessage (tool_use block)
// ---------------------------------------------------------------------------

describe('agent.tool.use maps to assistant tool_use message', () => {
  it('produces a tool_use ContentBlock with name, id, and input', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.tool.use',
      {
        ...BASE,
        toolName: 'read_file',
        toolCallId: 'tc-42',
        args: { path: '/src/index.ts' },
      },
      state,
    );
    expect(result).toMatchSnapshot();
  });

  it('handles an empty args object', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.tool.use',
      { ...BASE, toolName: 'list_directory', toolCallId: 'tc-43', args: {} },
      state,
    );
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// agent.tool.output → SDKAssistantMessage (tool_result block)
// ---------------------------------------------------------------------------

describe('agent.tool.output maps to assistant tool_result message', () => {
  it('produces a tool_result ContentBlock with content and id', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.tool.output',
      { ...BASE, toolCallId: 'tc-42', output: 'export function hello() {}' },
      state,
    );
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// agent.complete → SDKResultMessage
// ---------------------------------------------------------------------------

describe('agent.complete maps to result message', () => {
  it('maps a successful completion to subtype "success"', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.complete',
      { ...BASE, outcome: 'completed', message: 'Task finished.' },
      state,
    ) as SDKResultMessage;
    // Normalise the wall-clock-dependent duration_ms before snapshotting.
    expect(normaliseResultMessage(result)).toMatchSnapshot();
  });

  it('maps an error outcome to subtype "error"', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.complete',
      { ...BASE, outcome: 'error', error: 'Rate limit exceeded.' },
      state,
    ) as SDKResultMessage;
    expect(normaliseResultMessage(result)).toMatchSnapshot();
  });

  it('increments num_turns on each call to the same state', () => {
    const state = createAccumulatorState();
    mapBusEventToSdkMessage('agent.complete', { ...BASE, outcome: 'completed', message: 'Turn 1' }, state);
    const second = mapBusEventToSdkMessage(
      'agent.complete',
      { ...BASE, outcome: 'completed', message: 'Turn 2' },
      state,
    ) as SDKResultMessage;
    expect(second.num_turns).toBe(2);
  });

  it('carries accumulated usage into the result', () => {
    const state = createAccumulatorState();
    // Accumulate some tokens first.
    mapBusEventToSdkMessage(
      'agent.usage',
      {
        ...BASE,
        provider: 'anthropic',
        model: 'sonnet',
        inputTokens: 50,
        inputCachedTokens: 10,
        cacheWriteTokens: 5,
        outputTokens: 100,
        reasoningTokens: 0,
        totalTokens: 150,
        costUnits: 1,
        costUnitType: 'tokens',
        cost: 0.002,
      },
      state,
    );
    const result = mapBusEventToSdkMessage(
      'agent.complete',
      { ...BASE, outcome: 'completed', message: 'Done.' },
      state,
    ) as SDKResultMessage;
    expect(result.usage.input_tokens).toBe(50);
    expect(result.usage.output_tokens).toBe(100);
    expect(result.usage.cache_read_input_tokens).toBe(10);
    expect(result.usage.cache_creation_input_tokens).toBe(5);
    expect(result.total_cost_usd).toBeCloseTo(0.002);
  });
});

// ---------------------------------------------------------------------------
// agent.contextWindow.updated → SDKCompactBoundaryMessage
// ---------------------------------------------------------------------------

describe('agent.contextWindow.updated maps to compact boundary message', () => {
  it('produces a system/compact message with level and percentage', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE, level: 'warn', percentage: 75, currentTokens: 75000, maxTokens: 100000 },
      state,
    );
    expect(result).toMatchSnapshot();
  });

  it('produces a "critical" level message', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE, level: 'critical', percentage: 95, currentTokens: 95000, maxTokens: 100000 },
      state,
    );
    expect(result).toMatchSnapshot();
  });

  it('returns null when the level has not changed (dedup)', () => {
    const state = createAccumulatorState();
    // First emission sets the level.
    mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE, level: 'warn', percentage: 70, currentTokens: 70000, maxTokens: 100000 },
      state,
    );
    // Second emission at the same level must be suppressed.
    const duplicate = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE, level: 'warn', percentage: 80, currentTokens: 80000, maxTokens: 100000 },
      state,
    );
    expect(duplicate).toBeNull();
  });

  it('emits again when the level escalates from warn to critical', () => {
    const state = createAccumulatorState();
    mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE, level: 'warn', percentage: 70, currentTokens: 70000, maxTokens: 100000 },
      state,
    );
    const escalated = mapBusEventToSdkMessage(
      'agent.contextWindow.updated',
      { ...BASE, level: 'critical', percentage: 95, currentTokens: 95000, maxTokens: 100000 },
      state,
    );
    expect(escalated).not.toBeNull();
    expect(escalated).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// agent.usage → accumulates into state, yields null
// ---------------------------------------------------------------------------

describe('agent.usage accumulates into state and yields null', () => {
  it('returns null (no yielded message)', () => {
    const state = createAccumulatorState();
    const result = mapBusEventToSdkMessage(
      'agent.usage',
      {
        ...BASE,
        provider: 'anthropic',
        model: 'sonnet',
        inputTokens: 100,
        inputCachedTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 200,
        reasoningTokens: 0,
        totalTokens: 300,
        costUnits: 1,
        costUnitType: 'tokens',
        cost: 0.001,
      },
      state,
    );
    expect(result).toBeNull();
  });

  it('multiple usage events accumulate additively', () => {
    const state = createAccumulatorState();
    mapBusEventToSdkMessage(
      'agent.usage',
      { ...BASE, inputTokens: 100, outputTokens: 200, inputCachedTokens: 0, cacheWriteTokens: 0, cost: 0.001 },
      state,
    );
    mapBusEventToSdkMessage(
      'agent.usage',
      { ...BASE, inputTokens: 50, outputTokens: 75, inputCachedTokens: 20, cacheWriteTokens: 5, cost: 0.0005 },
      state,
    );
    expect(state.usage.input_tokens).toBe(150);
    expect(state.usage.output_tokens).toBe(275);
    expect(state.usage.cache_read_input_tokens).toBe(20);
    expect(state.usage.cache_creation_input_tokens).toBe(5);
    expect(state.totalCost).toBeCloseTo(0.0015);
  });
});

// ---------------------------------------------------------------------------
// Unknown events → null
// ---------------------------------------------------------------------------

describe('unknown bus events', () => {
  it('returns null for unrecognised subjects', () => {
    const state = createAccumulatorState();
    expect(mapBusEventToSdkMessage('agent.unknown', BASE, state)).toBeNull();
    expect(mapBusEventToSdkMessage('session.started', BASE, state)).toBeNull();
    expect(mapBusEventToSdkMessage('', BASE, state)).toBeNull();
  });
});

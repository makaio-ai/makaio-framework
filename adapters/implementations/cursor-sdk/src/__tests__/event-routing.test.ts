import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeltaHandler, createStepHandler, createTurnEventState } from '../event-routing.js';
import { CursorSdkNamespace, CursorSdkSubjects } from '../namespaces/index.js';

class RoutingTurnHarness {
  public stepStartedCalls = 0;
  public stepFinishedCalls = 0;

  public constructor(private readonly rejectLifecycle = false) {}

  /**
   * Minimal implementation of the turn lifecycle method consumed by event routing.
   */
  public async markStepStarted(): Promise<void> {
    this.stepStartedCalls += 1;
    if (this.rejectLifecycle) throw new Error('step start failed');
  }

  /**
   * Minimal implementation of the turn lifecycle method consumed by event routing.
   */
  public async markStepFinished(): Promise<void> {
    this.stepFinishedCalls += 1;
    if (this.rejectLifecycle) throw new Error('step finish failed');
  }
}

describe('cursor SDK event routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes non-JSON shell output through the real scoped bus', async () => {
    const bus = await CursorSdkNamespace.scopedBus();
    const routedPayloads: Array<{ delta: string }> = [];
    const unsubscribe = bus.on(CursorSdkSubjects.shell_output_delta, ({ payload }) => {
      routedPayloads.push(payload);
    });
    const turn = new RoutingTurnHarness();
    const state = createTurnEventState();
    const handler = createDeltaHandler(
      {
        bus,
        agentId: 'agent-1',
        metadata: { agentId: 'agent-1', adapterId: 'adapter-1', adapterName: 'cursor-sdk' },
        messageId: 'message-1',
      },
      turn,
      state,
    );
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    try {
      handler({ update: { type: 'shell-output-delta', event: circular } });
      await Promise.resolve();

      expect(routedPayloads).toContainEqual(expect.objectContaining({ delta: '[object Object]' }));
    } finally {
      unsubscribe();
    }
  });

  it('derives tool completion errors from Cursor status payloads', async () => {
    const bus = await CursorSdkNamespace.scopedBus();
    const routedPayloads: Array<{ isError: boolean; result?: unknown }> = [];
    const unsubscribe = bus.on(CursorSdkSubjects.tool_completed, ({ payload }) => {
      routedPayloads.push(payload);
    });
    const turn = new RoutingTurnHarness();
    const state = createTurnEventState();
    const handler = createDeltaHandler(
      {
        bus,
        agentId: 'agent-1',
        metadata: { agentId: 'agent-1', adapterId: 'adapter-1', adapterName: 'cursor-sdk' },
        messageId: 'message-1',
      },
      turn,
      state,
    );

    try {
      handler({
        update: {
          type: 'tool-call-completed',
          callId: 'tool-1',
          toolCall: { type: 'shell', status: 'completed', result: { status: 'error', error: 'denied' } },
        },
      });
      handler({
        update: {
          type: 'tool-call-completed',
          callId: 'tool-2',
          toolCall: { type: 'shell', status: 'error', result: { status: 'success', value: 'ignored' } },
        },
      });
      await Promise.resolve();

      expect(routedPayloads).toEqual([
        expect.objectContaining({ isError: true, result: { status: 'error', error: 'denied' } }),
        expect.objectContaining({ isError: true, result: { status: 'success', value: 'ignored' } }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('handles rejected step lifecycle transitions explicitly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = await CursorSdkNamespace.scopedBus();
    const turn = new RoutingTurnHarness(true);
    const state = createTurnEventState();
    const config = {
      bus,
      agentId: 'agent-1',
      metadata: { agentId: 'agent-1', adapterId: 'adapter-1', adapterName: 'cursor-sdk' },
      messageId: 'message-1',
    };

    createDeltaHandler(config, turn, state)({ update: { type: 'text-delta', text: 'hello' } });
    createStepHandler(config, turn, state)({ step: {} });
    await Promise.resolve();

    expect(turn.stepStartedCalls).toBe(1);
    expect(turn.stepFinishedCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('[CursorSdkEventRouting] turn.markStepStarted failed:', expect.any(Error));
    expect(errorSpy).toHaveBeenCalledWith('[CursorSdkEventRouting] turn.markStepFinished failed:', expect.any(Error));
  });
});

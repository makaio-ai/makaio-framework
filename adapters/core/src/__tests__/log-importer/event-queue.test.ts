import { describe, it, expect, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';

import { LogImportEventQueue } from '../../log-importer/event-queue.js';
import type { NormalizedEvent } from '../../log-importer/types.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

/**
 * Build a minimal agent-started event for queue ordering tests.
 * @param agentId - Agent identifier used to distinguish emitted events.
 * @returns A normalized `agent.started` event with a matching adapter session ID.
 */
function startedEvent(agentId: string): NormalizedEvent {
  return {
    subject: AgentSubjects.started,
    payload: {
      agentId,
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: `adapter-session-${agentId}`,
      model: 'gpt-4',
      cwd: null,
    },
  };
}

describe('LogImportEventQueue', () => {
  it('does not spend event rate-limit budget on cursor tasks', async () => {
    const onEventEmitted = vi.fn();
    const queue = new LogImportEventQueue({ eventsPerSecond: 1, onEventEmitted });
    const emittedAgents: string[] = [];
    let resolveSecondProcessed: (() => void) | undefined;
    const secondProcessed = new Promise<void>((resolve) => {
      resolveSecondProcessed = resolve;
    });
    cleanups.push(
      MakaioBus.on(AgentSubjects.started, (ctx) => {
        emittedAgents.push(ctx.payload.agentId);
        if (ctx.payload.agentId === 'agent-2') {
          resolveSecondProcessed?.();
        }
      }),
    );

    const event = queue.queueEvent(startedEvent('agent-1'));
    const secondEvent = queue.queueEvent(startedEvent('agent-2'));
    const cursor = queue.queueAfterEvents(async () => undefined, [event]);

    await event;
    await expect(
      Promise.race([cursor.then(() => 'cursor' as const), secondProcessed.then(() => 'second' as const)]),
    ).resolves.toBe('cursor');
    await secondEvent;

    expect(emittedAgents).toEqual(['agent-1', 'agent-2']);
    expect(onEventEmitted).toHaveBeenCalledTimes(2);
  });

  it('propagates preceding event failures to cursor tasks', async () => {
    const queue = new LogImportEventQueue({ eventsPerSecond: 1, onEventEmitted: vi.fn() });
    cleanups.push(
      MakaioBus.on(AgentSubjects.started, () => {
        throw new Error('emit failed');
      }),
    );

    const event = queue.queueEvent(startedEvent('agent-1'));
    const cursor = queue.queueAfterEvents(async () => undefined, [event]);

    await expect(cursor).rejects.toThrow('emit failed');
  });
});

import { describe, expect, it } from 'vitest';
import { AgentRuntimeMutationBarrier } from '../agent-runtime-mutation-barrier.js';

describe('AgentRuntimeMutationBarrier', () => {
  it('serializes complete actions in call order', async () => {
    const barrier = new AgentRuntimeMutationBarrier();
    const events: string[] = [];

    const first = barrier.runExclusive(async () => {
      events.push('first:start');
      await Promise.resolve();
      events.push('first:end');
    });
    const second = barrier.runExclusive(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases the next action after an earlier action rejects', async () => {
    const barrier = new AgentRuntimeMutationBarrier();
    const events: string[] = [];

    const first = barrier.runExclusive(async () => {
      events.push('first:start');
      throw new Error('boom');
    });
    const second = barrier.runExclusive(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await expect(first).rejects.toThrow('boom');
    await second;

    expect(events).toEqual(['first:start', 'second:start', 'second:end']);
  });
});

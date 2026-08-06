import { describe, expect, it } from 'vitest';
import { SerialLane } from '../serial-lane.js';

/**
 * Resolves after a macrotask, long enough for any competing microtask chain to
 * finish first if the lane failed to serialize.
 * @param ms - Delay in milliseconds.
 * @returns Resolves after the delay.
 */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('SerialLane', () => {
  it('returns each operation result to its own caller', async () => {
    const lane = new SerialLane();

    await expect(lane.run(async () => 'first')).resolves.toBe('first');
    await expect(lane.run(async () => 2)).resolves.toBe(2);
  });

  it('runs operations in submission order without overlapping them', async () => {
    const lane = new SerialLane();
    const events: string[] = [];

    /**
     * Records entry and exit around an awaited gap.
     * @param label - Operation label recorded in the trace.
     * @param ms - Gap the operation holds the lane for.
     * @returns Resolves once the operation completed.
     */
    const traced = (label: string, ms: number): Promise<void> =>
      lane.run(async () => {
        events.push(`enter:${label}`);
        await delay(ms);
        events.push(`exit:${label}`);
      });

    // The first operation holds the lane longest: a lane that did not serialize
    // would let the later, faster operations finish inside its gap.
    await Promise.all([traced('a', 20), traced('b', 5), traced('c', 0)]);

    expect(events).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c']);
  });

  it('surfaces a failure only to its own caller and keeps draining', async () => {
    const lane = new SerialLane();
    const failure = new Error('operation failed');

    const rejected = lane.run(async () => {
      throw failure;
    });
    const successor = lane.run(async () => 'ran anyway');

    await expect(rejected).rejects.toBe(failure);
    await expect(successor).resolves.toBe('ran anyway');
  });

  it('keeps ordering across a failure', async () => {
    const lane = new SerialLane();
    const events: string[] = [];

    const rejected = lane.run(async () => {
      events.push('enter:failing');
      await delay(10);
      events.push('exit:failing');
      throw new Error('boom');
    });
    const successor = lane.run(async () => {
      events.push('enter:successor');
    });

    await expect(rejected).rejects.toThrow('boom');
    await successor;

    expect(events).toEqual(['enter:failing', 'exit:failing', 'enter:successor']);
  });

  it('gives each lane instance its own tail', async () => {
    const first = new SerialLane();
    const second = new SerialLane();
    const events: string[] = [];

    const slow = first.run(async () => {
      await delay(20);
      events.push('first');
    });
    const fast = second.run(async () => {
      events.push('second');
    });

    await Promise.all([slow, fast]);

    // Independent lanes must not serialize against each other.
    expect(events).toEqual(['second', 'first']);
  });
});

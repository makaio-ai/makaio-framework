/**
 * Contract of {@link HandleGate}: the serialization primitive every SQLite
 * driver adapter routes its statements and transactions through.
 */
import { describe, expect, it } from 'vitest';
import { HandleGate } from '../engine/sqlite/handle-gate';
import { ReentrantOperationError } from '../reentrant-operation-error';

describe('HandleGate', () => {
  it('runs a statement on a free handle synchronously and keeps its result', () => {
    const gate = new HandleGate();
    expect(gate.run(() => 'result')).toBe('result');
  });

  it('holds back statements from outside the holder until it settled, in arrival order', async () => {
    const gate = new HandleGate();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const held = gate.exclusive(async () => {
      await release.promise;
      events.push('holder:end');
    });

    const outside = [1, 2].map(async (n) => gate.run(() => events.push(`statement:${n}`)));
    await Promise.resolve();
    expect(events).toEqual([]);

    release.resolve();
    await Promise.all([held, ...outside]);
    expect(events).toEqual(['holder:end', 'statement:1', 'statement:2']);
  });

  it('never holds back statements from the holder own async context', async () => {
    const gate = new HandleGate();
    const events: string[] = [];
    await gate.exclusive(async () => {
      events.push(await gate.run(() => 'direct'));
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      events.push(await gate.run(() => 'after timer'));
    });
    expect(events).toEqual(['direct', 'after timer']);
  });

  it('runs exclusive work one at a time and releases the handle after a failure', async () => {
    const gate = new HandleGate();
    const events: string[] = [];
    const release = Promise.withResolvers<void>();
    const first = gate.exclusive(async () => {
      events.push('first:start');
      await release.promise;
      throw new Error('first failed');
    });
    const second = gate.exclusive(async () => {
      events.push('second:start');
    });
    const firstOutcome = first.catch((error: unknown) => error);

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    release.resolve();
    expect(await firstOutcome).toEqual(new Error('first failed'));
    await second;
    expect(events).toEqual(['first:start', 'second:start']);
    expect(gate.run(() => 'free')).toBe('free');
  });

  it('rejects exclusive access requested from inside the holder instead of waiting for itself', async () => {
    const gate = new HandleGate();
    let nestedStarted = false;

    const outcome = await gate
      .exclusive(async () => {
        await gate.exclusive(async () => {
          nestedStarted = true;
        });
      })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(ReentrantOperationError);
    expect(nestedStarted).toBe(false);
    // The rejected nested request must not have disturbed the holder's release.
    expect(gate.run(() => 'free')).toBe('free');
    await expect(gate.exclusive(async () => 'next')).resolves.toBe('next');
  });

  it('reports whether the caller belongs to the current holder', async () => {
    const gate = new HandleGate();
    const release = Promise.withResolvers<void>();
    let fromStaleContext: (() => boolean) | undefined;
    expect(gate.heldByCaller()).toBe(false);

    await gate.exclusive(async () => {
      expect(gate.heldByCaller()).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(gate.heldByCaller()).toBe(true);
      // Keep the holder's async context around beyond the holder itself.
      setTimeout(() => {
        fromStaleContext = () => gate.heldByCaller();
        release.resolve();
      }, 1);
    });
    expect(gate.heldByCaller()).toBe(false);

    // A context that outlived its holder is not part of the next one.
    const next = Promise.withResolvers<void>();
    const holding = gate.exclusive(async () => next.promise);
    await release.promise;
    expect(fromStaleContext?.()).toBe(false);
    next.resolve();
    await holding;
  });
});

import { describe, expect, it } from 'vitest';
import { InvocationAdmissionGate, type AdmissionRelease, type AdmissionResult } from '../invocation-admission-gate.js';

// Pure promise-ordering tests: nothing here sleeps, so the assertions describe
// the gate's contract rather than a timing window.

/** Queue cap generous enough that these cases never reach it. */
const UNCONSTRAINED_QUEUE = 8;

/** Never-aborting signal for invocations that are not under cancellation. */
const liveSignal = (): AbortSignal => new AbortController().signal;

/**
 * Assert an admission attempt was granted and return its release handle.
 * @param result - Outcome of one admission attempt.
 * @returns The granted release handle.
 */
const admitted = (result: AdmissionResult): AdmissionRelease => {
  expect(result).toMatchObject({ admitted: true });
  if (!result.admitted) throw new Error('unreachable');
  return result.release;
};

/**
 * Acquire a slot and assert that it was granted.
 * @param gate - Gate under test.
 * @param signal - Signal for the acquiring invocation.
 * @returns The granted release handle.
 */
const acquireAdmitted = async (gate: InvocationAdmissionGate, signal: AbortSignal): Promise<AdmissionRelease> =>
  admitted(await gate.acquire(signal));

describe('InvocationAdmissionGate', () => {
  it('admits up to the configured limit without waiting', async () => {
    const gate = new InvocationAdmissionGate(2, UNCONSTRAINED_QUEUE);

    await acquireAdmitted(gate, liveSignal());
    await acquireAdmitted(gate, liveSignal());
  });

  it('holds the next invocation until a slot is released', async () => {
    const gate = new InvocationAdmissionGate(1, UNCONSTRAINED_QUEUE);
    const first = await acquireAdmitted(gate, liveSignal());

    const settled: string[] = [];
    const second = gate.acquire(liveSignal()).then((result) => {
      settled.push('second');
      return result;
    });

    // A queued invocation must not be admitted by merely yielding the turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toEqual([]);

    first();
    admitted(await second);
    expect(settled).toEqual(['second']);
  });

  it('admits waiting invocations in arrival order', async () => {
    const gate = new InvocationAdmissionGate(1, UNCONSTRAINED_QUEUE);
    const first = await acquireAdmitted(gate, liveSignal());
    const order: number[] = [];

    const second = gate.acquire(liveSignal()).then((result) => {
      order.push(2);
      return result;
    });
    const third = gate.acquire(liveSignal()).then((result) => {
      order.push(3);
      return result;
    });

    first();
    admitted(await second)();
    await third;

    expect(order).toEqual([2, 3]);
  });

  it('reports an invocation whose signal already aborted as not admitted', async () => {
    const gate = new InvocationAdmissionGate(1, UNCONSTRAINED_QUEUE);
    const controller = new AbortController();
    controller.abort('cancellation');

    expect(await gate.acquire(controller.signal)).toEqual({ admitted: false, refusal: 'aborted' });
    // The rejected invocation must not have consumed the slot.
    await acquireAdmitted(gate, liveSignal());
  });

  it('lets a waiting invocation leave the queue when its signal aborts', async () => {
    const gate = new InvocationAdmissionGate(1, UNCONSTRAINED_QUEUE);
    const first = await acquireAdmitted(gate, liveSignal());
    const controller = new AbortController();

    const abandoned = gate.acquire(controller.signal);
    const queued = gate.acquire(liveSignal());

    controller.abort('cancellation');
    expect(await abandoned).toEqual({ admitted: false, refusal: 'aborted' });

    // The abandoned waiter must not still be holding the queue position.
    first();
    admitted(await queued);
  });

  it('hands a released slot on only once', async () => {
    const gate = new InvocationAdmissionGate(1, UNCONSTRAINED_QUEUE);
    const first = await acquireAdmitted(gate, liveSignal());

    const second = gate.acquire(liveSignal());
    const third = gate.acquire(liveSignal());

    first();
    first();
    admitted(await second);

    let thirdAdmitted = false;
    void third.then(() => {
      thirdAdmitted = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(thirdAdmitted).toBe(false);
  });

  it('refuses an invocation that arrives at a full queue instead of enqueueing it', async () => {
    const gate = new InvocationAdmissionGate(1, 1);
    const first = await acquireAdmitted(gate, liveSignal());

    const queued = gate.acquire(liveSignal());
    // Distinguishes refusal from waiting: this resolves now, while `queued`
    // cannot resolve until the slot is released.
    expect(await gate.acquire(liveSignal())).toEqual({ admitted: false, refusal: 'queue_full' });

    // And the refusal must not have taken the queue position it was denied:
    // the one waiter is still the one that gets the released slot.
    first();
    admitted(await queued);
  });

  it('refuses everything beyond the limit when no queue is configured', async () => {
    const gate = new InvocationAdmissionGate(1, 0);
    const first = await acquireAdmitted(gate, liveSignal());

    expect(await gate.acquire(liveSignal())).toEqual({ admitted: false, refusal: 'queue_full' });

    // Refusals must not consume or leak the slot: releasing still admits.
    first();
    await acquireAdmitted(gate, liveSignal());
  });

  it('admits again once a refused burst has left and a slot frees up', async () => {
    const gate = new InvocationAdmissionGate(1, 1);
    const first = await acquireAdmitted(gate, liveSignal());
    const queued = gate.acquire(liveSignal());

    for (let refused = 0; refused < 5; refused += 1) {
      expect(await gate.acquire(liveSignal())).toEqual({ admitted: false, refusal: 'queue_full' });
    }

    first();
    const second = admitted(await queued);
    // A refusal that had silently enqueued would have taken this slot instead.
    second();
    await acquireAdmitted(gate, liveSignal());
  });
});

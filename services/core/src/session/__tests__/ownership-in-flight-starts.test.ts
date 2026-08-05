/**
 * Tests for the exclusive-start seam.
 *
 * The seam's whole guarantee is an ordering one — the entry exists before the
 * attempt writes anything, and survives until the attempt's cleanup is done —
 * so the assertions are about *when* an entry is visible, not about what the
 * attempt did.
 */
import { describe, it, expect } from 'vitest';
import { peekInFlightStart, runExclusiveStart } from '../ownership/in-flight-starts.js';

describe('runExclusiveStart', () => {
  it('publishes the entry before the attempt runs and clears it after the attempt finishes', async () => {
    const agentId = `agent-${crypto.randomUUID()}`;
    let visibleInsideAttempt: boolean | undefined;
    let releaseAttempt: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolveStarted) => {
      const gate = new Promise<void>((resolveGate) => {
        releaseAttempt = resolveGate;
      });
      runExclusiveStart(agentId, async () => {
        // Anything the attempt writes happens from here on, so the entry has to
        // be visible already: there must be no instant at which a `starting`
        // row exists without a joinable entry.
        visibleInsideAttempt = peekInFlightStart(agentId) !== undefined;
        resolveStarted();
        await gate;
        return 'connected';
      });
    });

    expect(peekInFlightStart(agentId)).toBeDefined();
    await attemptStarted;
    expect(visibleInsideAttempt).toBe(true);

    const entry = peekInFlightStart(agentId);
    expect(entry).toBeDefined();
    releaseAttempt?.();
    await entry?.settled;
    expect(peekInFlightStart(agentId)).toBeUndefined();
  });

  it('joins an existing attempt instead of running a second one', async () => {
    const agentId = `agent-${crypto.randomUUID()}`;
    let attempts = 0;
    let releaseAttempt: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });

    const first = runExclusiveStart(agentId, async () => {
      attempts += 1;
      await gate;
      return 'connected';
    });
    const second = runExclusiveStart(agentId, async () => {
      attempts += 1;
      return 'connected';
    });

    // Two concurrent lifecycle attempts for one agent identity are exactly what
    // this seam exists to prevent, so the second caller joins the first attempt
    // and is told so — a joiner ran none of the caller's durable work and must
    // not repeat it against its own inputs.
    expect(first.joined).toBe(false);
    expect(second.joined).toBe(true);
    expect(second.settled).toBe(first.settled);
    releaseAttempt?.();
    await first.settled;
    expect(attempts).toBe(1);
  });

  it('clears the entry when the attempt fails, and reports the failure to joiners', async () => {
    const agentId = `agent-${crypto.randomUUID()}`;
    const failure = new Error('pre-dispatch failure');

    const entry = runExclusiveStart(agentId, async () => {
      throw failure;
    });
    const joiner = peekInFlightStart(agentId);
    expect(joiner?.settled).toBe(entry.settled);

    // A rejection is the one verdict the promise cannot carry as a value, and a
    // joiner reads it as "no connector, and I know why".
    await expect(joiner?.settled).rejects.toThrow('pre-dispatch failure');
    expect(peekInFlightStart(agentId)).toBeUndefined();

    // A later attempt for the same agent gets a fresh entry.
    const next = runExclusiveStart(agentId, async () => 'connected');
    expect(next.joined).toBe(false);
    expect(next.settled).not.toBe(entry.settled);
    await next.settled;
  });
  it('never publishes an entry whose promise is already settled', async () => {
    // A joiner arriving during the attempt's synchronous prefix must not find a
    // resolved promise and conclude the attempt is over before it began. The
    // attempt itself is the only code that can observe that window, so it is
    // where the assertion has to be made.
    const agentId = `agent-${crypto.randomUUID()}`;
    let releaseAttempt: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    let peekedDuringPrefix: 'pending' | 'settled' | 'missing' = 'missing';

    const started = runExclusiveStart(agentId, async () => {
      const joined = peekInFlightStart(agentId);
      if (joined !== undefined) {
        // The marker is delayed by a *macrotask*, not a microtask. An entry
        // published carrying an already-resolved stand-in would still take a
        // microtask or two to deliver through `Promise.race`, so a marker that
        // is merely already-resolved wins every time and the assertion below
        // can never go red — the exact shape of a guard that tests nothing.
        const marker = Symbol('pending');
        const stillPending = new Promise<symbol>((resolve) => {
          setTimeout(() => resolve(marker), 0);
        });
        peekedDuringPrefix = (await Promise.race([joined.settled, stillPending])) === marker ? 'pending' : 'settled';
      }
      await gate;
      return 'connected';
    });

    releaseAttempt?.();
    await started.settled;
    expect(peekedDuringPrefix).toBe('pending');
  });
});

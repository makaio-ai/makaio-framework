import { describe, expect, it } from 'bun:test';
import { CorrelationTracker } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// AbortSignal mock helpers
// ---------------------------------------------------------------------------

/**
 * Overridable properties for {@link createMockAbortSignal}.
 *
 * Only the fields exercised by CorrelationTracker need to be customized;
 * the factory supplies safe no-op defaults for the rest.
 */
interface MockAbortSignalOverrides {
  aborted?: boolean | (() => boolean);
  reason?: unknown;
  addEventListener?: (type: string, listener: unknown, options?: unknown) => void;
  removeEventListener?: (type: string, listener: unknown, options?: unknown) => void;
}

/**
 * Build a structurally complete AbortSignal mock.
 *
 * Implements every member of the AbortSignal + EventTarget interface so the
 * returned value is directly assignable to AbortSignal without a double-cast.
 * Override only the fields your test scenario needs to customize.
 * @param overrides - Fields to override from their safe defaults
 * @returns A structurally complete AbortSignal mock
 */
function createMockAbortSignal(overrides: MockAbortSignalOverrides = {}): AbortSignal {
  const { aborted: abortedOrGetter = false, reason = undefined } = overrides;

  const getAborted = typeof abortedOrGetter === 'function' ? abortedOrGetter : () => abortedOrGetter;

  const mock: AbortSignal = {
    get aborted() {
      return getAborted();
    },
    get reason() {
      return reason;
    },
    onabort: null,
    throwIfAborted(): void {
      if (getAborted()) throw reason;
    },
    addEventListener: overrides.addEventListener ?? (() => undefined),
    removeEventListener: overrides.removeEventListener ?? (() => undefined),
    dispatchEvent: () => false,
  };

  return mock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CorrelationTracker abort races', () => {
  it('uses AbortSignal reason when already aborted before tracking starts', async () => {
    const tracker = new CorrelationTracker();
    const signal = AbortSignal.abort('already-aborted');

    await expect(tracker.track('race-corr-0', 5_000, signal)).rejects.toMatchObject({
      message: 'already-aborted',
      cause: 'already-aborted',
    });
  });

  it('rejects and cleans up when signal aborts during listener setup without dispatching abort event', async () => {
    const tracker = new CorrelationTracker();
    let aborted = false;
    let removeListenerCalls = 0;

    const signal = createMockAbortSignal({
      aborted: () => aborted,
      reason: new Error('race-aborted'),
      addEventListener: (_type: string, _listener: unknown): void => {
        // Simulate a race where aborted flips before listener callback dispatch.
        aborted = true;
      },
      removeEventListener: (_type: string, _listener: unknown): void => {
        removeListenerCalls += 1;
      },
    });

    await expect(tracker.track('race-corr-1', 5_000, signal)).rejects.toThrow('race-aborted');
    expect(removeListenerCalls).toBe(1);
  });

  it('rejects and cleans up when abort listener fires immediately', async () => {
    const tracker = new CorrelationTracker();

    const signal = createMockAbortSignal({
      aborted: false,
      reason: new Error('immediate-aborted'),
      addEventListener: (_type: string, listener: unknown): void => {
        if (typeof listener === 'function') {
          listener(new Event('abort'));
          return;
        }
        (listener as { handleEvent: (event: Event) => void }).handleEvent(new Event('abort'));
      },
      removeEventListener: (): void => {},
    });

    await expect(tracker.track('race-corr-2', 5_000, signal)).rejects.toThrow('immediate-aborted');
  });

  it('normalizes non-Error abort reason to Error and preserves reason as cause', async () => {
    const tracker = new CorrelationTracker();
    const reason = { code: 'ABORTED_BY_CALLER' };
    const controller = new AbortController();

    controller.abort(reason);

    await expect(tracker.track('race-corr-3', 5_000, controller.signal)).rejects.toMatchObject({
      message: 'Request aborted',
      cause: reason,
    });
  });
});

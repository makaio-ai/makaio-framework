import type { PartyRef } from '@makaio/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOwnWork,
  CONCURRENT_OWN_WORK_PURPOSES,
  getOwnCallReport,
  noteOwnContextSend,
  OWN_WORK_PURPOSES,
  openHandlerCallCount,
  trackOpenHandlerCall,
} from '../call-context/own-work.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEY = 'MAKAIO_OWN_CALL_REPORT';

const carrierA: PartyRef = { kind: 'makaio.extension', id: 'ext-a' };
const carrierB: PartyRef = { kind: 'makaio.extension', id: 'ext-b' };

/**
 * Create a promise together with its settle functions.
 * @returns The promise and its resolve and reject functions.
 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Let pending promise callbacks run.
 * @returns A promise that resolves after a macrotask.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  __resetOwnWork?.();
});

afterEach(() => {
  if (savedMode === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedMode;
  __resetOwnWork?.();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Purposes
// ---------------------------------------------------------------------------

describe('own work purposes', () => {
  it('declares schedule, observer, shared-work and stop as concurrent', () => {
    expect([...CONCURRENT_OWN_WORK_PURPOSES].sort()).toEqual(['observer', 'schedule', 'shared-work', 'stop']);
  });

  it('lists start and root as the purposes that are not concurrent', () => {
    const reported = OWN_WORK_PURPOSES.filter((purpose) => !CONCURRENT_OWN_WORK_PURPOSES.has(purpose));
    expect([...reported].sort()).toEqual(['root', 'start']);
  });
});

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

describe('trackOpenHandlerCall', () => {
  it('is zero for a carrier that never ran a handler', () => {
    expect(openHandlerCallCount(carrierA)).toBe(0);
  });

  it('raises the counter while a synchronous handler runs and releases it afterwards', () => {
    let seenInside = -1;
    const result = trackOpenHandlerCall(carrierA, () => {
      seenInside = openHandlerCallCount(carrierA);
      return 42;
    });

    expect(result).toBe(42);
    expect(seenInside).toBe(1);
    expect(openHandlerCallCount(carrierA)).toBe(0);
  });

  it('keeps the counter raised until a returned promise has resolved', async () => {
    const gate = deferred();
    const returned = trackOpenHandlerCall(carrierA, () => gate.promise);

    expect(openHandlerCallCount(carrierA)).toBe(1);
    gate.resolve();
    await returned;
    await flush();

    expect(openHandlerCallCount(carrierA)).toBe(0);
  });

  it('returns the original promise unchanged', () => {
    const gate = deferred();
    const returned = trackOpenHandlerCall(carrierA, () => gate.promise);

    expect(returned).toBe(gate.promise);
    gate.resolve();
  });

  it('releases the counter when a synchronous handler throws and rethrows the same error', () => {
    const failure = new Error('boom');

    expect(() =>
      trackOpenHandlerCall(carrierA, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(openHandlerCallCount(carrierA)).toBe(0);
  });

  it('releases the counter when the promise rejects and leaves the rejection to the caller', async () => {
    const gate = deferred();
    const failure = new Error('rejected');
    const returned = trackOpenHandlerCall(carrierA, () => gate.promise);

    expect(openHandlerCallCount(carrierA)).toBe(1);
    gate.reject(failure);
    await expect(returned).rejects.toBe(failure);
    await flush();

    expect(openHandlerCallCount(carrierA)).toBe(0);
  });

  it('counts concurrent and nested calls of one carrier', async () => {
    const first = deferred();
    const second = deferred();
    void trackOpenHandlerCall(carrierA, () => first.promise);
    void trackOpenHandlerCall(carrierA, () => second.promise);
    expect(openHandlerCallCount(carrierA)).toBe(2);

    first.resolve();
    await flush();
    expect(openHandlerCallCount(carrierA)).toBe(1);

    second.resolve();
    await flush();
    expect(openHandlerCallCount(carrierA)).toBe(0);

    let nested = -1;
    trackOpenHandlerCall(carrierA, () => {
      trackOpenHandlerCall(carrierA, () => {
        nested = openHandlerCallCount(carrierA);
      });
    });
    expect(nested).toBe(2);
    expect(openHandlerCallCount(carrierA)).toBe(0);
  });

  it('counts per carrier', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    expect(openHandlerCallCount(carrierA)).toBe(1);
    expect(openHandlerCallCount(carrierB)).toBe(0);
    expect(openHandlerCallCount({ kind: 'makaio.host', id: 'ext-a' })).toBe(0);
    gate.resolve();
  });

  it('treats a thenable result like a promise', async () => {
    let settle: () => void = () => undefined;
    const thenable = {
      then(onFulfilled: () => void): void {
        settle = onFulfilled;
      },
    };
    trackOpenHandlerCall(carrierA, () => thenable);

    expect(openHandlerCallCount(carrierA)).toBe(1);
    settle();
    expect(openHandlerCallCount(carrierA)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe('noteOwnContextSend', () => {
  it('records nothing when the carrier has no open handler call', () => {
    noteOwnContextSend(carrierA, 'start', 'ext.topic');

    expect(getOwnCallReport()).toEqual([]);
  });

  it('reports start and root while a handler call of the same carrier is open', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, 'start', 'ext.one');
    noteOwnContextSend(carrierA, 'root', 'ext.two');

    expect(getOwnCallReport()).toEqual([
      { carrier: carrierA, purpose: 'start', subject: 'ext.one', occurrences: 1 },
      { carrier: carrierA, purpose: undefined, subject: 'ext.two', occurrences: 1 },
    ]);
    gate.resolve();
  });

  it('reports a send without purpose while a handler call of the same carrier is open', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, undefined, 'ext.topic');

    expect(getOwnCallReport()).toEqual([
      { carrier: carrierA, purpose: undefined, subject: 'ext.topic', occurrences: 1 },
    ]);
    gate.resolve();
  });

  it('puts root and a send without purpose into the same entry with an undefined purpose', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, undefined, 'ext.topic');
    noteOwnContextSend(carrierA, 'root', 'ext.topic');
    noteOwnContextSend(carrierA, undefined, 'ext.topic');

    expect(getOwnCallReport()).toEqual([
      { carrier: carrierA, purpose: undefined, subject: 'ext.topic', occurrences: 3 },
    ]);
    gate.resolve();
  });

  it('records nothing for a send without purpose when no handler call is open', () => {
    noteOwnContextSend(carrierA, undefined, 'ext.topic');
    noteOwnContextSend(carrierA, 'root', 'ext.topic');

    expect(getOwnCallReport()).toEqual([]);
  });

  it('records nothing for a send without purpose of a carrier without open handler call', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierB, undefined, 'ext.topic');

    expect(getOwnCallReport()).toEqual([]);
    gate.resolve();
  });

  it('never reports the declared concurrent purposes', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    for (const purpose of CONCURRENT_OWN_WORK_PURPOSES) {
      noteOwnContextSend(carrierA, purpose, 'ext.topic');
    }

    expect(getOwnCallReport()).toEqual([]);
    gate.resolve();
  });

  it.each([
    'schedule',
    'observer',
    'shared-work',
    'stop',
  ] as const)('never reports %s, also with a purpose-less send nearby', (purpose) => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, purpose, 'ext.concurrent');
    noteOwnContextSend(carrierA, undefined, 'ext.topic');

    expect(getOwnCallReport()).toEqual([
      { carrier: carrierA, purpose: undefined, subject: 'ext.topic', occurrences: 1 },
    ]);
    gate.resolve();
  });

  it('does not report a send of another carrier than the one with the open call', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierB, 'start', 'ext.topic');

    expect(getOwnCallReport()).toEqual([]);
    gate.resolve();
  });

  it('folds repeats of one carrier, purpose and subject into one entry', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    noteOwnContextSend(carrierA, 'start', 'ext.topic');

    expect(getOwnCallReport()).toEqual([{ carrier: carrierA, purpose: 'start', subject: 'ext.topic', occurrences: 3 }]);
    gate.resolve();
  });

  it('keeps entries apart when subject or purpose differ', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, 'start', 'ext.one');
    noteOwnContextSend(carrierA, 'start', 'ext.two');
    noteOwnContextSend(carrierA, 'root', 'ext.one');

    expect(getOwnCallReport()).toHaveLength(3);
    gate.resolve();
  });

  it('keeps carriers apart that share an id but not a kind', () => {
    const gate = deferred();
    const host: PartyRef = { kind: 'makaio.host', id: carrierA.id };
    void trackOpenHandlerCall(carrierA, () => gate.promise);
    void trackOpenHandlerCall(host, () => gate.promise);

    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    noteOwnContextSend(host, 'start', 'ext.topic');

    expect(getOwnCallReport()).toHaveLength(2);
    gate.resolve();
  });

  it('does not report once the handler call has settled (boundary after await)', async () => {
    const gate = deferred();
    const handler = trackOpenHandlerCall(carrierA, async () => {
      await gate.promise;
    });

    // Still open: a send after the await inside the handler is reported.
    noteOwnContextSend(carrierA, 'start', 'ext.inside');
    gate.resolve();
    await handler;
    await flush();
    // Settled: the same send is plain own work.
    noteOwnContextSend(carrierA, 'start', 'ext.after');

    expect(getOwnCallReport().map((entry) => entry.subject)).toEqual(['ext.inside']);
  });

  it('does not report a send made after a synchronous handler has returned', () => {
    trackOpenHandlerCall(carrierA, () => undefined);

    noteOwnContextSend(carrierA, 'start', 'ext.topic');

    expect(getOwnCallReport()).toEqual([]);
  });

  it('returns a snapshot that later changes and caller edits do not touch', () => {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);
    noteOwnContextSend(carrierA, 'start', 'ext.topic');

    const snapshot = getOwnCallReport();
    noteOwnContextSend(carrierA, 'start', 'ext.topic');

    expect(snapshot[0]?.occurrences).toBe(1);
    expect(getOwnCallReport()[0]?.occurrences).toBe(2);
    expect(snapshot[0]?.carrier).not.toBe(getOwnCallReport()[0]?.carrier);
    gate.resolve();
  });
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe('report mode (MAKAIO_OWN_CALL_REPORT)', () => {
  /**
   * Open a handler call of carrier A and send a reportable own context.
   * @param subject - Subject of the send.
   * @returns Function that settles the open handler call.
   */
  function sendWhileOpen(subject: string): () => void {
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);
    noteOwnContextSend(carrierA, 'start', subject);
    return gate.resolve;
  }

  it('records and does not write in count mode', () => {
    process.env[ENV_KEY] = 'count';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    sendWhileOpen('ext.topic')();

    expect(getOwnCallReport()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses count mode when the variable is unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    sendWhileOpen('ext.topic')();

    expect(getOwnCallReport()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to count mode for an unknown value', () => {
    process.env[ENV_KEY] = 'loud';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    sendWhileOpen('ext.topic')();

    expect(getOwnCallReport()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records nothing in off mode', () => {
    process.env[ENV_KEY] = 'off';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    sendWhileOpen('ext.topic')();

    expect(getOwnCallReport()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('records and warns once per entry in warn mode', () => {
    process.env[ENV_KEY] = 'warn';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const settle = sendWhileOpen('ext.topic');
    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    noteOwnContextSend(carrierA, 'start', 'ext.topic');

    expect(getOwnCallReport()[0]?.occurrences).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('ext-a');
    expect(message).toContain('ext.topic');
    expect(message).toContain("own('start')");

    noteOwnContextSend(carrierA, 'start', 'ext.other');
    expect(warn).toHaveBeenCalledTimes(2);
    settle();
  });

  it('warns once for a send without purpose with the call-form hint', () => {
    process.env[ENV_KEY] = 'warn';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, undefined, 'ext.topic');
    noteOwnContextSend(carrierA, 'root', 'ext.topic');

    expect(getOwnCallReport()).toEqual([
      { carrier: carrierA, purpose: undefined, subject: 'ext.topic', occurrences: 2 },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "[MakaioBus] Carrier 'makaio.extension:ext-a' sent 'ext.topic' without call while one of its handler calls was still open. Pass the handled message's ctx.call.",
    );
    gate.resolve();
  });

  it('reads the mode on every send', () => {
    process.env[ENV_KEY] = 'off';
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    expect(getOwnCallReport()).toEqual([]);

    process.env[ENV_KEY] = 'count';
    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    expect(getOwnCallReport()).toHaveLength(1);
    gate.resolve();
  });

  it('still counts open handler calls in off mode', () => {
    process.env[ENV_KEY] = 'off';
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);

    expect(openHandlerCallCount(carrierA)).toBe(1);
    gate.resolve();
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('__resetOwnWork', () => {
  it('is available under NODE_ENV test and clears counters, entries and warn memory', () => {
    process.env[ENV_KEY] = 'warn';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred();
    void trackOpenHandlerCall(carrierA, () => gate.promise);
    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    expect(__resetOwnWork).toBeTypeOf('function');

    __resetOwnWork?.();

    expect(openHandlerCallCount(carrierA)).toBe(0);
    expect(getOwnCallReport()).toEqual([]);

    // The warn memory is cleared too: the same entry warns again.
    void trackOpenHandlerCall(carrierA, () => gate.promise);
    noteOwnContextSend(carrierA, 'start', 'ext.topic');
    expect(warn).toHaveBeenCalledTimes(2);
    gate.resolve();
  });
});

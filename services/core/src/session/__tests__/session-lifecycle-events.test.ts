/**
 * Tests for the locality degradation event helper
 * ({@link emitLocalityDegradeEvent}).
 *
 * Focus: best-effort semantics — both the persist path and the live bus
 * emission are caught so that a faulty subscriber or storage outage never
 * turns a non-critical notice into an unhandled rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { NativeLocalityVerdict } from '@makaio/contracts';
import { emitLocalityDegradeEvent } from '../session-lifecycle-events.js';
import { SessionEventStorageSubjects } from '../session-events/index.js';

describe('emitLocalityDegradeEvent', () => {
  let bus: IMakaioBus;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    bus = createBusInstance();
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    vi.restoreAllMocks();
  });

  /**
   * Register a storage append handler that records calls.
   * @returns Array of persisted events
   */
  function registerAppendHandler(): Array<unknown> {
    const persisted: Array<unknown> = [];
    const unsub = bus.on(SessionEventStorageSubjects.append, (ctx) => {
      persisted.push(ctx.payload.event);
      ctx.setResult({ success: true });
    });
    cleanups.push(unsub);
    return persisted;
  }

  it('silently ignores native verdicts', async () => {
    const verdict: NativeLocalityVerdict = { kind: 'native' };
    // Should resolve immediately without emitting anything.
    await emitLocalityDegradeEvent(bus, {
      sessionId: 'sess-1',
      intent: 'resume',
      verdict,
    });
    // No assertion needed — the absence of a rejection is the test.
  });

  it('persists and emits a degrade verdict', async () => {
    const persisted = registerAppendHandler();
    const received: Array<unknown> = [];
    cleanups.push(
      bus.on(SessionSubjects.locality.degraded, (ctx) => {
        received.push(ctx.payload);
      }),
    );

    await emitLocalityDegradeEvent(bus, {
      sessionId: 'sess-1',
      intent: 'resume',
      verdict: { kind: 'degrade', reason: 'cwd-mismatch' },
    });

    expect(persisted).toHaveLength(1);
    expect(received).toHaveLength(1);
  });

  it('resolves when a bus subscriber throws (best-effort live emit)', async () => {
    registerAppendHandler();

    // A faulty subscriber that always throws.
    cleanups.push(
      bus.on(SessionSubjects.locality.degraded, () => {
        throw new Error('subscriber boom');
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Must resolve — not reject — despite the throwing subscriber.
    await expect(
      emitLocalityDegradeEvent(bus, {
        sessionId: 'sess-1',
        intent: 'resume',
        verdict: { kind: 'degrade', reason: 'adapter-unsupported' },
      }),
    ).resolves.toBeUndefined();

    // The warning should mention the live emission failure.
    expect(warnSpy).toHaveBeenCalledWith(
      '[session-lifecycle-events] Failed to emit live locality.degraded event',
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
  });

  it('resolves when storage append fails (best-effort persist)', async () => {
    // Storage handler that always rejects.
    cleanups.push(
      bus.on(SessionEventStorageSubjects.append, () => {
        throw new Error('storage boom');
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const received: Array<unknown> = [];
    cleanups.push(
      bus.on(SessionSubjects.locality.degraded, (ctx) => {
        received.push(ctx.payload);
      }),
    );

    await expect(
      emitLocalityDegradeEvent(bus, {
        sessionId: 'sess-1',
        intent: 'fork',
        verdict: { kind: 'foreign', machineId: 'remote-box' },
      }),
    ).resolves.toBeUndefined();

    // Persist failure was caught; live emit still fired.
    expect(warnSpy).toHaveBeenCalledWith(
      '[session-lifecycle-events] Failed to persist locality.degraded event',
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
    expect(received).toHaveLength(1);
  });

  it('resolves when both persist and live emit fail', async () => {
    cleanups.push(
      bus.on(SessionEventStorageSubjects.append, () => {
        throw new Error('storage boom');
      }),
    );
    cleanups.push(
      bus.on(SessionSubjects.locality.degraded, () => {
        throw new Error('subscriber boom');
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      emitLocalityDegradeEvent(bus, {
        sessionId: 'sess-1',
        intent: 'resume',
        verdict: { kind: 'degrade', reason: 'cwd-mismatch' },
      }),
    ).resolves.toBeUndefined();

    // Both failures logged.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

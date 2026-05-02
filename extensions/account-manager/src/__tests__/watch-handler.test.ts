/**
 * Tests for the `watch` CLI handler.
 *
 * Exercises NDJSON stream output against a real `MakaioBus` using the same
 * bus-level event emission that the account-manager service uses in
 * production. The NDJSON output is captured via the injected CLI writer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { OutputWriter } from '@makaio/kernel/cli';
import { handleWatch } from '../cli/handlers/watch.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  for (const fn of cleanups.splice(0)) {
    fn();
  }
});

/**
 * Build a minimal CommandContext for the watch handler.
 * @param signal - AbortSignal used to stop the watch session.
 * @returns A CommandContext-compatible object.
 */
function makeCtx(signal: AbortSignal) {
  const output: OutputWriter = {
    write: (text) => {
      stdoutChunks.push(text);
    },
    error: (text) => {
      stderrChunks.push(text);
    },
  };

  return {
    bus: MakaioBus,
    args: {},
    output,
    signal,
    setExitCode: (_code: number) => {
      // no-op for watch tests
    },
  };
}

/** Parse all captured stdout lines as NDJSON records. */
function parsedLines(): Array<Record<string, unknown>> {
  return stdoutChunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// NDJSON stream
// ---------------------------------------------------------------------------

describe('handleWatch', () => {
  it('writes credentials.detected event as NDJSON line', async () => {
    const controller = new AbortController();

    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    MakaioBus.emit(AccountManagerSubjects.credentials.detected, {
      clientId: 'claude',
      account: { id: 'acc-1', metadata: {}, active: true, detectedAt: 0, lastSeenAt: 0 },
      autoLabeled: false,
    });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'credentials.detected', clientId: 'claude' });
  });

  it('writes credentials.switched event as NDJSON line', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    const from = { id: 'acc-1', metadata: {}, active: false, detectedAt: 0, lastSeenAt: 0 };
    const to = { id: 'acc-2', metadata: {}, active: true, detectedAt: 0, lastSeenAt: 0 };
    MakaioBus.emit(AccountManagerSubjects.credentials.switched, { clientId: 'claude', from, to });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'credentials.switched', clientId: 'claude' });
  });

  it('writes credentials.refreshed event as NDJSON line', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    MakaioBus.emit(AccountManagerSubjects.credentials.refreshed, {
      clientId: 'codex',
      account: { id: 'acc-3', metadata: {}, active: true, detectedAt: 0, lastSeenAt: 0 },
    });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'credentials.refreshed', clientId: 'codex' });
  });

  it('writes credentials.error event as NDJSON line', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    MakaioBus.emit(AccountManagerSubjects.credentials.error, {
      clientId: 'claude',
      message: 'keychain locked',
    });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'credentials.error', clientId: 'claude', message: 'keychain locked' });
  });

  it('writes usage.updated event as NDJSON line', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    MakaioBus.emit(AccountManagerSubjects.usage.updated, {
      clientId: 'claude',
      accountId: 'acc-1',
      usage: {
        fetchedAt: Date.now(),
        windows: [
          { id: '5h', label: '5 Hour', utilization: 73, resetsAt: Date.now() + 7200_000, windowSeconds: 18000 },
        ],
      },
    });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'usage.updated', clientId: 'claude', accountId: 'acc-1' });
  });

  it('writes accounts.metadataPatched event as NDJSON line', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    MakaioBus.emit(AccountManagerSubjects.accounts.metadataPatched, {
      clientId: 'codex',
      account: { id: 'acc-1', metadata: { planType: 'plus' }, active: true, detectedAt: 0, lastSeenAt: 0 },
    });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'accounts.metadataPatched',
      clientId: 'codex',
      account: { id: 'acc-1' },
    });
  });

  it('writes multiple events in order', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    MakaioBus.emit(AccountManagerSubjects.credentials.error, { clientId: 'a', message: 'first' });
    MakaioBus.emit(AccountManagerSubjects.credentials.error, { clientId: 'b', message: 'second' });

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    const lines = parsedLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ clientId: 'a', message: 'first' });
    expect(lines[1]).toMatchObject({ clientId: 'b', message: 'second' });
  });

  it('resolves immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await handleWatch(makeCtx(controller.signal));

    expect(parsedLines()).toHaveLength(0);
  });

  it('stops emitting after signal aborts', async () => {
    const controller = new AbortController();
    const watchPromise = handleWatch(makeCtx(controller.signal));

    await Promise.resolve();

    controller.abort();
    await watchPromise;

    MakaioBus.emit(AccountManagerSubjects.credentials.error, { clientId: 'claude', message: 'too late' });

    await Promise.resolve();

    expect(parsedLines()).toHaveLength(0);
  });
});

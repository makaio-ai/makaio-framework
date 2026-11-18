import { describe, expect, it } from 'vitest';
import {
  deriveEndCause,
  describeProcessExit,
  describeTransportEnd,
  type EndCause,
  type EndFact,
  type TransportEnd,
} from '../process-end.js';

const stop: EndFact = { kind: 'stop-requested' };
const exited = (code: number | null, signal: NodeJS.Signals | null = null): EndFact => ({
  kind: 'process-ended',
  exit: { kind: 'exited', code, signal },
});
const spawnFailed: EndFact = {
  kind: 'process-ended',
  exit: { kind: 'spawn-failed', error: Object.assign(new Error('spawn /bin/x ENOENT'), { code: 'ENOENT' }) },
};
const unobserved: EndFact = { kind: 'process-ended', exit: { kind: 'unobserved', reason: 'signal-denied' } };
const stdinFailed: EndFact = {
  kind: 'communication-failed',
  failure: { kind: 'stdin-failed', error: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
};
const stdoutFailed: EndFact = {
  kind: 'communication-failed',
  failure: { kind: 'stdout-failed', error: new Error('read failed') },
};
const stdoutEnded: EndFact = { kind: 'communication-failed', failure: { kind: 'stdout-ended' } };

describe('deriveEndCause', () => {
  // Every ordering of the transport facts in the design's transition table.
  const orderings: ReadonlyArray<readonly [name: string, facts: readonly EndFact[], cause: EndCause]> = [
    ['close() before a requested exit', [stop, exited(null, 'SIGTERM')], 'requested'],
    ['close() before an exit with code 0', [stop, exited(0)], 'requested'],
    ['close() before a failed spawn', [stop, spawnFailed], 'requested'],
    ['close() whose exit was never observed', [stop, unobserved], 'requested'],
    ['close() before the stdout error it caused', [stop, stdoutFailed, exited(null, 'SIGTERM')], 'requested'],
    ['exit with code 0 before any stop intent', [exited(0)], 'unexpected'],
    ['exit with code 1 before any stop intent', [exited(1)], 'unexpected'],
    ['signal the transport did not send', [exited(null, 'SIGKILL')], 'unexpected'],
    ['exit before the stop intent', [exited(1), stop], 'unexpected'],
    ['close() during delivery of an unexpected end', [exited(0), stop], 'unexpected'],
    ['failed spawn', [spawnFailed], 'spawn-failed'],
    ['close() during delivery of a failed spawn', [spawnFailed, stop], 'spawn-failed'],
    ['stdin failure before a failed spawn is reported', [stdinFailed, spawnFailed], 'spawn-failed'],
    ['stdin failure, then the stop path', [stdinFailed, stop, exited(null, 'SIGTERM')], 'unexpected'],
    ['stdout error, then the stop path', [stdoutFailed, exited(null, 'SIGTERM')], 'unexpected'],
    ['terminal stdout end, then an exit never observed', [stdoutEnded, unobserved], 'unexpected'],
    ['terminal stdout end, then close()', [stdoutEnded, stop, exited(null, 'SIGTERM')], 'unexpected'],
  ];

  it.each(orderings)('%s', (_name, facts, cause) => {
    expect(deriveEndCause(facts)).toBe(cause);
  });

  it('reads each fact kind at its first occurrence only', () => {
    expect(deriveEndCause([exited(1), stop, spawnFailed])).toBe('unexpected');
    expect(deriveEndCause([stop, exited(1), stop])).toBe('requested');
  });
});

describe('describeProcessExit', () => {
  it('names the exit code and the signal separately', () => {
    expect(describeProcessExit({ kind: 'exited', code: 0, signal: null })).toBe('exited with code 0');
    expect(describeProcessExit({ kind: 'exited', code: null, signal: 'SIGTERM' })).toBe('exited with signal SIGTERM');
    expect(describeProcessExit({ kind: 'exited', code: null, signal: null })).toBe('exited without a code or signal');
  });

  it('names a failed spawn by its errno code, never by its message', () => {
    const error = Object.assign(new Error('spawn /opt/tool --token=secret-value ENOENT'), { code: 'ENOENT' });

    expect(describeProcessExit({ kind: 'spawn-failed', error })).toBe('could not be spawned (ENOENT)');
  });

  it('falls back to the error name when there is no errno code', () => {
    const error = new TypeError('secret-value');

    expect(describeProcessExit({ kind: 'spawn-failed', error })).toBe('could not be spawned (TypeError)');
  });

  it('states that an unobserved exit was not observed', () => {
    expect(describeProcessExit({ kind: 'unobserved', reason: 'observation-timeout' })).toBe(
      'exit not observed (observation-timeout)',
    );
  });
});

describe('describeTransportEnd', () => {
  it('describes a plain requested end by cause and exit only', () => {
    const end: TransportEnd = {
      cause: 'requested',
      exit: { kind: 'exited', code: null, signal: 'SIGTERM' },
      drain: { kind: 'complete', discardedChars: 0 },
      communicationFailure: undefined,
      tree: { kind: 'not-owned' },
    };

    expect(describeTransportEnd(end)).toBe('stopped on request: exited with signal SIGTERM');
  });

  it('reports the exit, the channel failure, the drain and the tree as separate facts', () => {
    const end: TransportEnd = {
      cause: 'unexpected',
      exit: { kind: 'exited', code: 0, signal: null },
      drain: { kind: 'timed-out', discardedChars: 42, stdoutComplete: false },
      communicationFailure: {
        kind: 'stdin-failed',
        error: Object.assign(new Error('write EPIPE token=secret-value'), { code: 'EPIPE' }),
      },
      tree: { kind: 'unproven', reason: 'ps-unavailable' },
    };

    const description = describeTransportEnd(end);

    expect(description).toBe(
      'ended unexpectedly: exited with code 0; stdin write failed (EPIPE); ' +
        'stdout truncated at the drain deadline (42 chars discarded); ' +
        'process group quiescence unproven (ps-unavailable)',
    );
    expect(description).not.toContain('secret-value');
  });

  it('names a failed listener by its error name only and leaves an unowned tree unmentioned', () => {
    const end: TransportEnd = {
      cause: 'unexpected',
      exit: { kind: 'exited', code: null, signal: 'SIGTERM' },
      drain: { kind: 'complete', discardedChars: 0 },
      communicationFailure: { kind: 'listener-failed', error: new TypeError('token=secret-value') },
      tree: { kind: 'not-owned' },
    };

    expect(describeTransportEnd(end)).toBe(
      'ended unexpectedly: exited with signal SIGTERM; message listener failed (TypeError)',
    );
  });

  it('describes a failed spawn without its error message', () => {
    const end: TransportEnd = {
      cause: 'spawn-failed',
      exit: {
        kind: 'spawn-failed',
        error: Object.assign(new Error('spawn /secret/path ENOENT'), { code: 'ENOENT' }),
      },
      drain: { kind: 'complete', discardedChars: 0 },
      communicationFailure: undefined,
      tree: { kind: 'quiescent' },
    };

    expect(describeTransportEnd(end)).toBe('failed to start: could not be spawned (ENOENT)');
  });

  it('mentions a discarded final line and a failed drain', () => {
    const base = {
      cause: 'unexpected',
      exit: { kind: 'exited', code: 1, signal: null },
      tree: { kind: 'not-owned' },
    } as const;

    expect(
      describeTransportEnd({
        ...base,
        drain: { kind: 'complete', discardedChars: 7 },
        communicationFailure: undefined,
      }),
    ).toBe('ended unexpectedly: exited with code 1; unterminated final stdout line discarded (7 chars)');
    expect(
      describeTransportEnd({
        ...base,
        drain: { kind: 'failed', discardedChars: 3 },
        communicationFailure: { kind: 'stdout-failed', error: new Error('boom') },
      }),
    ).toBe('ended unexpectedly: exited with code 1; stdout failed (Error); stdout drain failed (3 chars discarded)');
  });

  it('tells a held stderr apart from a truncated stdout, and an abandoned drain from a timed-out one', () => {
    const base = {
      cause: 'requested',
      communicationFailure: undefined,
      tree: { kind: 'not-owned' },
    } as const;

    expect(
      describeTransportEnd({
        ...base,
        exit: { kind: 'exited', code: 0, signal: null },
        drain: { kind: 'timed-out', discardedChars: 0, stdoutComplete: true },
      }),
    ).toBe('stopped on request: exited with code 0; stderr held open past the drain deadline');
    expect(
      describeTransportEnd({
        ...base,
        exit: { kind: 'unobserved', reason: 'signal-denied' },
        drain: { kind: 'abandoned', discardedChars: 5 },
      }),
    ).toBe(
      'stopped on request: exit not observed (signal-denied); stdout abandoned without a drain (5 chars discarded)',
    );
  });
});

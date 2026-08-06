/**
 * Case 207b — an adapter-instance shutdown stops conflating a timeout with a clean
 * close (Wave 3 R49).
 *
 * Driven against the real `shutdownAdapterInstances` over a map of real instance
 * objects, because the seam under test is what that function does with the three
 * outcomes a close hook can produce. Only the hooks themselves are the test's, and
 * they are the counterparty rather than the subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS,
  closeAdapterInstance,
  shutdownAdapterInstances,
} from '../adapter-runtime-lifecycle.js';
import { AdapterInstanceCloseTimeoutError } from '../adapter-instance-teardown.js';
import type { AdapterInstance } from '../adapter-runtime-types.js';

/** An instance whose close hook is whatever the arm needs it to be. */
interface TestInstance extends AdapterInstance {
  /** The lifecycle hook `resolveAdapterCloseHook` will pick. */
  readonly closeAsync?: () => Promise<void>;
}

/**
 * Build the three-instance map every arm of 207b needs.
 * @param stuck - Never-settling promise standing in for a hook that hangs.
 * @param failure - Failure the throwing instance's hook raises.
 * @returns Map in shutdown order: clean, stuck, throwing.
 */
function threeInstances(stuck: Promise<void>, failure: Error): Map<string, AdapterInstance> {
  const clean: TestInstance = { adapterId: 'clean', closeAsync: async () => undefined };
  const timesOut: TestInstance = { adapterId: 'times-out', closeAsync: () => stuck };
  const throws: TestInstance = {
    adapterId: 'throws',
    closeAsync: async () => {
      throw failure;
    },
  };
  return new Map<string, AdapterInstance>([
    ['clean', clean],
    ['times-out', timesOut],
    ['throws', throws],
  ]);
}

describe('case 207b: per-instance shutdown results', () => {
  beforeEach(() => {
    // The stuck hook is only reachable under controlled time: with the real
    // five-second budget this arm would be a five-second test and the next person
    // would delete it instead of fixing it.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('distinguishes a clean close, a timeout and a throw, and aggregates to `unknown`', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stuck = new Promise<void>(() => {});
    const failure = new Error('adapter close refused');
    const instances = threeInstances(stuck, failure);

    const shutdown = shutdownAdapterInstances(instances);
    await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
    const report = await shutdown;

    // The three outcomes are three different answers. Before R49's fix all three
    // were the same answer, which is what made an instance retirement unbuildable.
    expect(report.results.map(({ adapterId, evidence }) => ({ adapterId, evidence }))).toEqual([
      { adapterId: 'clean', evidence: 'detached' },
      { adapterId: 'times-out', evidence: 'unknown' },
      { adapterId: 'throws', evidence: 'unknown' },
    ]);
    // Both weak classes name *why*, and the two `unknown`s do not say the same
    // thing: one hook reported a failure, the other reported nothing at all.
    expect(report.results[0]?.detail).toContain('without reporting a class');
    expect(report.results[1]?.detail).toContain('did not return from its close hook');
    expect(report.results[2]?.detail).toContain('adapter close refused');

    // The weakest in the set, which is the wave's only aggregation rule.
    expect(report.evidence).toBe('unknown');

    // Unchanged, and asserted so the reporting change cannot quietly cost it: every
    // instance was attempted even though the second one never let go, and the map is
    // cleared regardless.
    expect(instances.size).toBe(0);
  });

  it('reports `released` for an instance that exposes no close hook', async () => {
    const instances = new Map<string, AdapterInstance>([['hookless', { adapterId: 'hookless' }]]);

    const report = await shutdownAdapterInstances(instances);

    // Nothing to tear down and nothing that can still speak through it — the same
    // answer `stopAgent` gives for an agent that is already gone.
    expect(report).toMatchObject({ evidence: 'released' });
    expect(report.results).toEqual([{ adapterId: 'hookless', evidence: 'released' }]);
  });

  it('reports `released` for an empty instance map', async () => {
    const report = await shutdownAdapterInstances(new Map());

    expect(report.evidence).toBe('released');
    expect(report.results).toEqual([]);
  });

  it('raises a typed timeout so a reporting caller need not parse prose', async () => {
    const instance: TestInstance = { adapterId: 'slow', closeAsync: () => new Promise<void>(() => {}) };

    const closing = closeAdapterInstance('slow', instance, 1_000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const failure = await closing;

    expect(failure).toBeInstanceOf(AdapterInstanceCloseTimeoutError);
    expect((failure as AdapterInstanceCloseTimeoutError).timeoutMs).toBe(1_000);
    expect((failure as AdapterInstanceCloseTimeoutError).adapterId).toBe('slow');
  });

  it('does not let a hook that fails after its timeout escape as an unhandled rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failLate: (error: Error) => void = () => undefined;
    const late = new Promise<void>((_, reject) => {
      failLate = reject;
    });
    const instance: TestInstance = { adapterId: 'late-failure', closeAsync: () => late };
    const instances = new Map<string, AdapterInstance>([['late-failure', instance]]);

    const shutdown = shutdownAdapterInstances(instances);
    await vi.advanceTimersByTimeAsync(ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
    const report = await shutdown;

    // The shutdown already reported the timeout; the hook then fails with nobody
    // left to tell, and a shutdown must not be the thing that crashes a process.
    failLate(new Error('hook failed long after nobody was listening'));
    await vi.advanceTimersByTimeAsync(0);

    expect(report.evidence).toBe('unknown');
  });
});

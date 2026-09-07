import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionAttemptSubjects } from '@makaio/contracts';
import { registerBootstrapStartHandler } from '../bootstrap-start-handler.js';
import { driveTestAttemptToAllocated, makeTestInstruction } from '../testing/attempt-fixtures.js';
import { attemptPeer, createAttemptGateHarness } from './execution-attempt-gate-harness.js';

const subject = ExecutionAttemptSubjects.bootstrap.awaitStart;

describe('attempt-authenticated bootstrap start ingress', () => {
  let harness: ReturnType<typeof createAttemptGateHarness>;
  let cleanup: () => void;
  beforeEach(() => {
    harness = createAttemptGateHarness();
    cleanup = registerBootstrapStartHandler(harness.bus, harness.authority);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects local, unauthenticated and mismatched requests before observing storage', async () => {
    const read = vi.spyOn(harness.repository, 'readBootstrapStartState');
    await expect(harness.bus.request(subject, { executionAttemptId: 'attempt' })).rejects.toThrow('authenticated');
    for (const peer of [
      undefined,
      { kind: 'workflow-execution-attempt', id: 'attempt', claims: { executionId: 'owner' }, authenticated: false },
      attemptPeer('different', 'owner'),
    ]) {
      const response = await harness.transport.requestAs(
        subject.$meta.namespace,
        subject.subject as string,
        { executionAttemptId: 'attempt' },
        peer,
      );
      expect(response.error).toBeDefined();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('parses the request at ingress and takes the owner only from the authenticated peer', async () => {
    const read = vi.spyOn(harness.repository, 'readBootstrapStartState');
    const malformed = await harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      { executionAttemptId: 'attempt', executionId: 'forged' },
      attemptPeer('attempt', 'owner'),
    );
    expect(malformed.error).toBeDefined();
    expect(read).not.toHaveBeenCalled();
    const response = await harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      { executionAttemptId: 'attempt' },
      attemptPeer('attempt', 'owner'),
    );
    expect(response.result).toEqual({ status: 'refused', reason: 'not-found' });
    expect(read).toHaveBeenCalledWith({ executionAttemptId: 'attempt', executionId: 'owner' });
  });

  it('waits for the allocation, without allocating a runtime generation or permission to work', async () => {
    vi.useFakeTimers();
    const { executionAttemptId } = await harness.authority.createAttempt('owner', makeTestInstruction());
    const response = harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      { executionAttemptId },
      attemptPeer(executionAttemptId, 'owner'),
    );
    await vi.advanceTimersByTimeAsync(200);
    await driveTestAttemptToAllocated(harness.authority, executionAttemptId, 'owner');
    await vi.advanceTimersByTimeAsync(100);
    expect((await response).result).toEqual({ status: 'permitted' });
    expect((await harness.authority.getAttemptControlState(executionAttemptId))?.runtimeGeneration).toBe(0);
    await harness.authority.createAttempt('owner', makeTestInstruction());
    await expect(
      harness.authority.registerRuntime({ executionAttemptId, executionId: 'owner', runtimeIncarnationId: 'runtime' }),
    ).resolves.toEqual({ kind: 'fenced' });
  });

  it('cancels pending waits when its handler is shut down, and cleanup is idempotent', async () => {
    vi.useFakeTimers();
    const { executionAttemptId } = await harness.authority.createAttempt('owner', makeTestInstruction());
    const response = harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      { executionAttemptId },
      attemptPeer(executionAttemptId, 'owner'),
    );
    await vi.advanceTimersByTimeAsync(100);
    cleanup();
    cleanup();
    expect((await response).error?.message).toContain('shut down');
    expect(vi.getTimerCount()).toBe(0);
  });
});

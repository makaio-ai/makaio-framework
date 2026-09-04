import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNamespace, WorkerSubjects } from '@makaio/contracts';
import type { OutcomeAckDecision, WorkflowRunResult } from '@makaio/contracts';
import { submitOutcomeWithAck, OutcomeDeliveryError, DELIVERED_DECISIONS } from '../outcome-submission.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create a bus with the Worker namespace and an outcome handler.
 * @param options - Handler behavior configuration.
 * @returns Bus and submission tracking.
 */
function createOutcomeBus(options: {
  /**
   * Sequence of decisions to return. Each call pops the first entry.
   * If an entry is `'throw'`, the handler throws a transient error.
   */
  decisions: ReadonlyArray<OutcomeAckDecision | 'throw'>;
}) {
  const bus = createBusInstance();
  bus.registerNamespace(WorkerNamespace);

  const submissions: Array<{
    executionAttemptId: string;
    executionId: string;
    result: unknown;
  }> = [];

  let callIndex = 0;
  bus.on(WorkerSubjects.control.outcome.submit, (ctx) => {
    submissions.push({ ...ctx.payload });
    const entry = options.decisions[callIndex++];
    if (entry === 'throw' || entry === undefined) {
      throw new Error('Transient outcome submission failure');
    }
    ctx.setResult({ decision: entry });
  });

  return { bus, submissions };
}

/**
 * Minimal completed result fixture.
 * @param executionId - Workflow execution identifier.
 */
function makeResult(executionId: string = 'exec-1'): WorkflowRunResult {
  return {
    executionId,
    workflowId: 'wf-1',
    status: 'completed',
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('submitOutcomeWithAck', () => {
  it('returns accepted on first attempt', async () => {
    const { bus } = createOutcomeBus({ decisions: ['accepted'] });
    const decision = await submitOutcomeWithAck(bus, {
      executionAttemptId: 'a-1',
      executionId: 'exec-1',
      result: makeResult(),
    });
    expect(decision).toBe('accepted');
  });

  it('returns duplicate as a successful delivery', async () => {
    const { bus } = createOutcomeBus({ decisions: ['duplicate'] });
    const decision = await submitOutcomeWithAck(bus, {
      executionAttemptId: 'a-1',
      executionId: 'exec-1',
      result: makeResult(),
    });
    expect(decision).toBe('duplicate');
  });

  it('throws OutcomeDeliveryError immediately on conflict', async () => {
    const { bus, submissions } = createOutcomeBus({
      decisions: ['conflict'],
    });
    await expect(
      submitOutcomeWithAck(bus, {
        executionAttemptId: 'a-1',
        executionId: 'exec-1',
        result: makeResult(),
      }),
    ).rejects.toThrow(OutcomeDeliveryError);
    // Only 1 attempt — no retries on conflict.
    expect(submissions).toHaveLength(1);
  });

  it('throws OutcomeDeliveryError immediately on fenced', async () => {
    const { bus, submissions } = createOutcomeBus({
      decisions: ['fenced'],
    });
    await expect(
      submitOutcomeWithAck(bus, {
        executionAttemptId: 'a-1',
        executionId: 'exec-1',
        result: makeResult(),
      }),
    ).rejects.toThrow(OutcomeDeliveryError);
    expect(submissions).toHaveLength(1);
  });

  it('retries on transient failures then succeeds', async () => {
    const { bus, submissions } = createOutcomeBus({
      decisions: ['throw', 'throw', 'accepted'],
    });
    const decision = await submitOutcomeWithAck(
      bus,
      {
        executionAttemptId: 'a-1',
        executionId: 'exec-1',
        result: makeResult(),
      },
      { retry: { baseDelayMs: 10, maxDelayMs: 50, deadlineMs: 5_000 } },
    );
    expect(decision).toBe('accepted');
    expect(submissions).toHaveLength(3);
  });

  it('invokes reconnect callback before each retry', async () => {
    const reconnectSpy = vi.fn().mockResolvedValue(undefined);
    const { bus, submissions } = createOutcomeBus({
      decisions: ['throw', 'throw', 'accepted'],
    });
    await submitOutcomeWithAck(
      bus,
      {
        executionAttemptId: 'a-1',
        executionId: 'exec-1',
        result: makeResult(),
      },
      {
        retry: { baseDelayMs: 10, maxDelayMs: 50, deadlineMs: 5_000 },
        reconnect: reconnectSpy,
      },
    );
    // reconnect is called before attempt 1 and attempt 2 (not before first attempt 0).
    expect(reconnectSpy).toHaveBeenCalledTimes(2);
    expect(submissions).toHaveLength(3);
  });

  it('reconnect failures are non-fatal — retry still proceeds', async () => {
    const reconnectSpy = vi.fn().mockRejectedValue(new Error('reconnect failed'));
    const { bus, submissions } = createOutcomeBus({
      decisions: ['throw', 'accepted'],
    });
    const decision = await submitOutcomeWithAck(
      bus,
      {
        executionAttemptId: 'a-1',
        executionId: 'exec-1',
        result: makeResult(),
      },
      {
        retry: { baseDelayMs: 10, maxDelayMs: 50, deadlineMs: 5_000 },
        reconnect: reconnectSpy,
      },
    );
    expect(decision).toBe('accepted');
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(submissions).toHaveLength(2);
  });

  it('exhausts retries and throws last error', async () => {
    const { bus, submissions } = createOutcomeBus({
      decisions: ['throw', 'throw', 'throw', 'throw'],
    });
    await expect(
      submitOutcomeWithAck(
        bus,
        {
          executionAttemptId: 'a-1',
          executionId: 'exec-1',
          result: makeResult(),
        },
        {
          retry: {
            maxRetries: 2,
            baseDelayMs: 10,
            maxDelayMs: 50,
            deadlineMs: 10_000,
          },
        },
      ),
    ).rejects.toThrow('Transient outcome submission failure');
    // 3 total attempts: initial + 2 retries.
    expect(submissions).toHaveLength(3);
  });

  it('respects overall deadline', async () => {
    // Set up: keep throwing but set a very short deadline
    const { bus } = createOutcomeBus({
      decisions: Array.from({ length: 100 }, () => 'throw' as const),
    });
    const startTime = Date.now();
    await expect(
      submitOutcomeWithAck(
        bus,
        {
          executionAttemptId: 'a-1',
          executionId: 'exec-1',
          result: makeResult(),
        },
        {
          retry: {
            maxRetries: 50,
            baseDelayMs: 5,
            maxDelayMs: 10,
            deadlineMs: 100,
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'OutcomeDeliveryError',
      decision: 'deadline-exceeded',
      reason: 'deadline-exceeded',
    });
    const elapsed = Date.now() - startTime;
    // Should have stopped well before 50 retries would take at 5ms each.
    expect(elapsed).toBeLessThan(2_000);
  });

  it.each([
    { maxRetries: -1 },
    { maxRetries: 1.5 },
    { baseDelayMs: 0 },
    { maxDelayMs: Number.POSITIVE_INFINITY },
    { deadlineMs: Number.NaN },
  ])('rejects invalid retry configuration %#', async (retry) => {
    const { bus } = createOutcomeBus({ decisions: ['accepted'] });
    await expect(
      submitOutcomeWithAck(
        bus,
        {
          executionAttemptId: 'a-1',
          executionId: 'exec-1',
          result: makeResult(),
        },
        { retry },
      ),
    ).rejects.toThrow(TypeError);
  });

  it('bounds a never-settling request to the overall deadline', async () => {
    vi.useFakeTimers();
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    bus.on(WorkerSubjects.control.outcome.submit, async () => await new Promise<never>(() => {}));

    try {
      const submission = submitOutcomeWithAck(
        bus,
        {
          executionAttemptId: 'a-1',
          executionId: 'exec-1',
          result: makeResult(),
        },
        { retry: { deadlineMs: 100 } },
      );
      const rejection = expect(submission).rejects.toMatchObject({
        name: 'OutcomeDeliveryError',
        decision: 'deadline-exceeded',
        reason: 'deadline-exceeded',
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a never-settling reconnect to the overall deadline', async () => {
    vi.useFakeTimers();
    const { bus, submissions } = createOutcomeBus({ decisions: ['throw'] });
    const reconnect = vi.fn(async () => await new Promise<never>(() => {}));

    try {
      const submission = submitOutcomeWithAck(
        bus,
        {
          executionAttemptId: 'a-1',
          executionId: 'exec-1',
          result: makeResult(),
        },
        { retry: { maxRetries: 1, baseDelayMs: 10, deadlineMs: 100 }, reconnect },
      );
      const rejection = expect(submission).rejects.toMatchObject({
        name: 'OutcomeDeliveryError',
        decision: 'deadline-exceeded',
        reason: 'deadline-exceeded',
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(submissions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('DELIVERED_DECISIONS contains exactly accepted and duplicate', () => {
    expect(DELIVERED_DECISIONS.has('accepted')).toBe(true);
    expect(DELIVERED_DECISIONS.has('duplicate')).toBe(true);
    expect(DELIVERED_DECISIONS.has('conflict')).toBe(false);
    expect(DELIVERED_DECISIONS.has('fenced')).toBe(false);
    expect(DELIVERED_DECISIONS.size).toBe(2);
  });
});

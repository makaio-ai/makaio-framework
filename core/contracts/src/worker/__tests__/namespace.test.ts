import { describe, expect, it } from 'vitest';
import { WorkerRuntimeInputsSchema, WorkerSchemas, WorkerSubjects } from '../index.js';

describe('worker namespace', () => {
  it('registers lifecycle subjects under worker', () => {
    expect(WorkerSubjects.lifecycle.ready.$meta.namespace).toBe('worker');
    expect(WorkerSubjects.lifecycle.ready.subject).toBe('lifecycle.ready');
  });

  it('registers dispatch under worker', () => {
    expect(WorkerSubjects.dispatch.$meta.namespace).toBe('worker');
    expect(WorkerSubjects.dispatch.subject).toBe('dispatch');
  });

  describe('runtime.inputs.get', () => {
    const runtimeInputs = {
      workerManifest: { contributionRefs: [] },
      suspensionStrategy: 'exit-and-redispatch',
    };

    it('registers the runtime input query under worker', () => {
      expect(WorkerSubjects.runtime.inputs.get.$meta.namespace).toBe('worker');
      expect(WorkerSubjects.runtime.inputs.get.subject).toBe('runtime.inputs.get');
    });

    it('queries by Attempt identity without a caller-supplied owner', () => {
      expect(WorkerSchemas['runtime.inputs.get'].request.parse({ executionAttemptId: 'attempt-1' })).toStrictEqual({
        executionAttemptId: 'attempt-1',
      });
      expect(
        WorkerSchemas['runtime.inputs.get'].request.safeParse({
          executionAttemptId: 'attempt-1',
          executionId: 'other-owner',
        }).success,
      ).toBe(false);
      expect(WorkerSchemas['runtime.inputs.get'].request.safeParse({ executionAttemptId: '' }).success).toBe(false);
    });

    it('returns selected contribution and suspension inputs without defaulting', () => {
      expect(WorkerSchemas['runtime.inputs.get'].response.parse({ runtimeInputs })).toStrictEqual({ runtimeInputs });
      expect(WorkerRuntimeInputsSchema.safeParse({ workerManifest: { contributionRefs: [] } }).success).toBe(false);
      expect(WorkerRuntimeInputsSchema.safeParse({ suspensionStrategy: 'wait-in-process' }).success).toBe(false);
    });

    it('represents a missing selected binding explicitly', () => {
      expect(WorkerSchemas['runtime.inputs.get'].response.parse({ runtimeInputs: null })).toStrictEqual({
        runtimeInputs: null,
      });
      expect(WorkerSchemas['runtime.inputs.get'].response.safeParse({}).success).toBe(false);
    });

    it.each([
      'env',
      'credentials',
      'terminalAuthority',
    ])('does not turn runtime inputs into an instruction or bootstrap envelope: %s', (field) => {
      expect(WorkerRuntimeInputsSchema.safeParse({ ...runtimeInputs, [field]: {} }).success).toBe(false);
    });
  });

  it('registers control.outcome.submit under worker', () => {
    expect(WorkerSubjects.control.outcome.submit.$meta.namespace).toBe('worker');
    expect(WorkerSubjects.control.outcome.submit.subject).toBe('control.outcome.submit');
  });

  describe('control.cancel-undelivered', () => {
    const undelivered = {
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      kind: 'unavailable',
      detail: 'no stop evidence: the addressed runtime did not answer',
      observedAt: '2026-09-10T10:00:00.000Z',
    };

    it('registers the undelivered-Cancel diagnostic outside the lifecycle prefix', () => {
      const subject = WorkerSubjects.control['cancel-undelivered'];

      expect(subject.$meta.namespace).toBe('worker');
      expect(subject.subject).toBe('control.cancel-undelivered');
      // Terminal-state projections key off the `lifecycle.` prefix, so the
      // diagnostic must never carry it (FACT-145 R2).
      expect(subject.subject.startsWith('lifecycle.')).toBe(false);
    });

    it('is a notification: no request/response pair', () => {
      expect(WorkerSubjects.control['cancel-undelivered'].$meta.isRequest).toBe(false);
    });

    it('carries the lifecycle identity plus the delivery outcome', () => {
      expect(WorkerSchemas['control.cancel-undelivered'].parse(undelivered)).toStrictEqual(undelivered);
    });

    it.each(['refused', 'invalid-receipt', 'receipt-not-recorded'])('accepts the %s outcome', (kind) => {
      expect(WorkerSchemas['control.cancel-undelivered'].safeParse({ ...undelivered, kind }).success).toBe(true);
    });

    it.each([
      ['stopped', 'kind'],
      ['', 'detail'],
      ['not-an-instant', 'observedAt'],
    ])('refuses %s for %s', (value, field) => {
      expect(WorkerSchemas['control.cancel-undelivered'].safeParse({ ...undelivered, [field]: value }).success).toBe(
        false,
      );
    });
  });

  it('keeps pool identity out of framework lifecycle payloads', () => {
    const parsed = WorkerSchemas['lifecycle.ready'].parse({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      poolId: 'pool-1',
      metadata: { source: 'test' },
    });

    expect(parsed).toStrictEqual({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      metadata: { source: 'test' },
    });
    expect('poolId' in parsed).toBe(false);
  });

  it('lifecycle events use executionAttemptId instead of nodeId', () => {
    const parsed = WorkerSchemas['lifecycle.ready'].parse({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
    });

    expect(parsed.executionAttemptId).toBe('attempt-1');
    expect('nodeId' in parsed).toBe(false);
  });

  it('keeps adapter composition out of lifecycle.ready payloads', () => {
    const parsed = WorkerSchemas['lifecycle.ready'].parse({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      adapters: ['claude-code'],
    });

    expect(parsed).toStrictEqual({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
    });
    expect('adapters' in parsed).toBe(false);
  });

  describe('lifecycle.paused', () => {
    it('defines lifecycle.paused with required gate and frame identity', () => {
      const parsed = WorkerSchemas['lifecycle.paused'].parse({
        executionAttemptId: 'attempt-1',
        executionId: 'wfx-1',
        environment: 'piscina',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      });

      expect(parsed).toMatchObject({
        executionAttemptId: 'attempt-1',
        executionId: 'wfx-1',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      });
    });

    it('rejects lifecycle.paused without pausedAtGateId', () => {
      expect(() =>
        WorkerSchemas['lifecycle.paused'].parse({
          executionAttemptId: 'attempt-1',
          executionId: 'wfx-1',
          environment: 'piscina',
          pausedAtFrameId: 'frame-approve-1',
        }),
      ).toThrow();
    });

    it('rejects lifecycle.paused without pausedAtFrameId', () => {
      expect(() =>
        WorkerSchemas['lifecycle.paused'].parse({
          executionAttemptId: 'attempt-1',
          executionId: 'wfx-1',
          environment: 'piscina',
          pausedAtGateId: 'approve',
        }),
      ).toThrow();
    });
  });
});

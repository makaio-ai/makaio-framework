import { describe, expect, it } from 'vitest';
import { WorkerNodeSchemas, WorkerNodeSubjects } from '../index.js';

describe('worker-node namespace', () => {
  it('registers lifecycle subjects under worker-node', () => {
    expect(WorkerNodeSubjects.lifecycle.ready.$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.lifecycle.ready.subject).toBe('lifecycle.ready');
  });

  it('registers dispatch under worker-node', () => {
    expect(WorkerNodeSubjects.dispatch.$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.dispatch.subject).toBe('dispatch');
  });

  it('registers control.attempt-ready under worker-node', () => {
    expect(WorkerNodeSubjects.control['attempt-ready'].$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.control['attempt-ready'].subject).toBe('control.attempt-ready');
  });

  it('registers control.outcome.submit under worker-node', () => {
    expect(WorkerNodeSubjects.control.outcome.submit.$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.control.outcome.submit.subject).toBe('control.outcome.submit');
  });

  it('keeps pool identity out of framework lifecycle payloads', () => {
    const parsed = WorkerNodeSchemas['lifecycle.ready'].parse({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      poolId: 'pool-1',
      adapters: ['claude-code'],
      metadata: { source: 'test' },
    });

    expect(parsed).toStrictEqual({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      adapters: ['claude-code'],
      metadata: { source: 'test' },
    });
    expect('poolId' in parsed).toBe(false);
  });

  it('lifecycle events use executionAttemptId instead of nodeId', () => {
    const parsed = WorkerNodeSchemas['lifecycle.ready'].parse({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      environment: 'piscina',
    });

    expect(parsed.executionAttemptId).toBe('attempt-1');
    expect('nodeId' in parsed).toBe(false);
  });

  it('parses control attempt-ready payloads', () => {
    const parsed = WorkerNodeSchemas['control.attempt-ready'].parse({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      adapters: ['claude-code'],
    });

    expect(parsed).toStrictEqual({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      adapters: ['claude-code'],
    });
  });

  describe('lifecycle.paused', () => {
    it('defines lifecycle.paused with required gate and frame identity', () => {
      const parsed = WorkerNodeSchemas['lifecycle.paused'].parse({
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
        WorkerNodeSchemas['lifecycle.paused'].parse({
          executionAttemptId: 'attempt-1',
          executionId: 'wfx-1',
          environment: 'piscina',
          pausedAtFrameId: 'frame-approve-1',
        }),
      ).toThrow();
    });

    it('rejects lifecycle.paused without pausedAtFrameId', () => {
      expect(() =>
        WorkerNodeSchemas['lifecycle.paused'].parse({
          executionAttemptId: 'attempt-1',
          executionId: 'wfx-1',
          environment: 'piscina',
          pausedAtGateId: 'approve',
        }),
      ).toThrow();
    });
  });
});

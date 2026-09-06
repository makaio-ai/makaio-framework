import { describe, expect, it } from 'vitest';
import { WorkerSchemas } from '../schemas.js';

describe('Worker bootstrap claim schema', () => {
  it('validates execution-scoped bootstrap claims without a repeated secret', () => {
    const request = WorkerSchemas['control.bootstrap.claim'].request.parse({
      executionId: 'exec-1',
      executionAttemptId: 'attempt-1',
    });
    const response = WorkerSchemas['control.bootstrap.claim'].response.parse({
      busUrl: 'wss://makaio-server.example/bus',
      busAuthSecret: 'execution-secret',
    });

    expect(request.executionAttemptId).toBe('attempt-1');
    expect(response.busAuthSecret).toBe('execution-secret');
  });

  it('rejects bootstrap claim with old nodeId field', () => {
    expect(() =>
      WorkerSchemas['control.bootstrap.claim'].request.parse({
        executionId: 'exec-1',
        nodeId: 'node-1',
      }),
    ).toThrow();
  });

  it('rejects bootstrap claim request with unknown fields', () => {
    expect(() =>
      WorkerSchemas['control.bootstrap.claim'].request.parse({
        executionId: 'exec-1',
        executionAttemptId: 'attempt-1',
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('rejects bootstrap claim response with unknown fields', () => {
    expect(() =>
      WorkerSchemas['control.bootstrap.claim'].response.parse({
        busUrl: 'wss://example/bus',
        busAuthSecret: 'secret',
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('rejects bootstrap claim request with empty strings', () => {
    expect(() =>
      WorkerSchemas['control.bootstrap.claim'].request.parse({
        executionId: '',
        executionAttemptId: 'attempt-1',
      }),
    ).toThrow();
  });
});

describe('control.outcome.submit schema', () => {
  it('validates outcome submission with executionAttemptId', () => {
    const request = WorkerSchemas['control.outcome.submit'].request.parse({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'completed',
      },
    });

    expect(request.executionAttemptId).toBe('attempt-1');
    expect(request.result.status).toBe('completed');
  });

  it('validates failed outcome submission', () => {
    const request = WorkerSchemas['control.outcome.submit'].request.parse({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'failed',
        error: 'adapter failed',
      },
    });

    expect(request.result).toMatchObject({ status: 'failed', error: 'adapter failed' });
  });

  it('validates cancelled outcome submission', () => {
    const request = WorkerSchemas['control.outcome.submit'].request.parse({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'cancelled',
        reason: 'user requested cancellation',
      },
    });

    expect(request.result.status).toBe('cancelled');
  });

  it('validates paused outcome submission', () => {
    const request = WorkerSchemas['control.outcome.submit'].request.parse({
      executionAttemptId: 'attempt-1',
      executionId: 'exec-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'paused',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      },
    });

    expect(request.result.status).toBe('paused');
  });

  it('rejects outcome when envelope and result executionId differ', () => {
    expect(() =>
      WorkerSchemas['control.outcome.submit'].request.parse({
        executionAttemptId: 'attempt-1',
        executionId: 'exec-1',
        result: {
          executionId: 'exec-2',
          workflowId: 'wf-1',
          status: 'completed',
        },
      }),
    ).toThrow(/result.executionId/);
  });

  it('rejects outcome request with old nodeId field', () => {
    expect(() =>
      WorkerSchemas['control.outcome.submit'].request.parse({
        nodeId: 'node-1',
        executionId: 'exec-1',
        result: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          status: 'completed',
        },
      }),
    ).toThrow();
  });

  it('rejects outcome request with unknown fields (strict)', () => {
    expect(() =>
      WorkerSchemas['control.outcome.submit'].request.parse({
        executionAttemptId: 'attempt-1',
        executionId: 'exec-1',
        result: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          status: 'completed',
        },
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('returns ACK decision in response', () => {
    for (const decision of ['accepted', 'duplicate', 'conflict', 'fenced'] as const) {
      const response = WorkerSchemas['control.outcome.submit'].response.parse({
        decision,
      });
      expect(response.decision).toBe(decision);
    }
  });

  it('rejects unknown ACK decisions in response', () => {
    expect(() =>
      WorkerSchemas['control.outcome.submit'].response.parse({
        decision: 'rejected',
      }),
    ).toThrow();
  });

  it('rejects response with unknown fields (strict)', () => {
    expect(() =>
      WorkerSchemas['control.outcome.submit'].response.parse({
        decision: 'accepted',
        extraField: 'should-fail',
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  WorkerSchemas,
  WorkerBootstrapCredentialsSchema,
  WorkerBootstrapDeadlineAtSchema,
  WorkerBootstrapGrantedClaimResponseSchema,
} from '../index.js';

describe('Worker bootstrap deadline schema', () => {
  it.each([
    '2026-09-07T10:00:00Z',
    '2026-09-07T12:00:00+02:00',
    '2026-09-07T10:00:00.123Z',
    new Date(Date.UTC(10000, 0, 1)).toISOString(),
    new Date(8_640_000_000_000_000).toISOString(),
    new Date(-8_640_000_000_000_000).toISOString(),
  ])('accepts the representable ISO deadline %s unchanged', (deadline) => {
    expect(WorkerBootstrapDeadlineAtSchema.parse(deadline)).toBe(deadline);
  });

  it.each([
    undefined,
    null,
    Infinity,
    '',
    'tomorrow',
    '2026-09-07',
    '2026-02-30T00:00:00Z',
    '+010000-01-01T00:00:00Z',
    '+275760-09-13T00:00:00.001Z',
  ])('rejects malformed or unrepresentable deadline %s without throwing during validation', (deadline) => {
    expect(WorkerBootstrapDeadlineAtSchema.safeParse(deadline).success).toBe(false);
  });
});

describe('Worker bootstrap claim schema', () => {
  it('validates execution-scoped bootstrap claims without a repeated secret', () => {
    const request = WorkerSchemas['control.bootstrap.claim'].request.parse({
      executionId: 'exec-1',
      executionAttemptId: 'attempt-1',
    });
    const response = WorkerSchemas['control.bootstrap.claim'].response.parse({
      status: 'granted',
      credentials: { busUrl: 'wss://makaio-server.example/bus', busAuthSecret: 'execution-secret' },
      runtimeEnv: {},
    });

    expect(request.executionAttemptId).toBe('attempt-1');
    if (response.status !== 'granted') throw new Error('Expected a grant');
    expect(response.credentials.busAuthSecret).toBe('execution-secret');
    expect(response.runtimeEnv).toEqual({});
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
        status: 'granted',
        credentials: { busUrl: 'wss://example/bus', busAuthSecret: 'secret' },
        runtimeEnv: {},
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('requires an explicit runtime environment even when it is empty', () => {
    const result = WorkerSchemas['control.bootstrap.claim'].response.safeParse({
      status: 'granted',
      credentials: { busUrl: 'wss://example/bus', busAuthSecret: 'secret' },
    });
    expect(result.success).toBe(false);
  });

  it('uses portable process-environment names for claimed Runtime input', () => {
    const schema = WorkerBootstrapGrantedClaimResponseSchema.shape.runtimeEnv;
    expect(schema.safeParse({ _VALID_1: '', lowercase: 'value' }).success).toBe(true);
    for (const name of ['', '1INVALID', 'INVALID-NAME', 'INVALID=NAME', 'INVALID.NAME']) {
      expect(schema.safeParse({ [name]: 'value' }).success).toBe(false);
    }
  });

  it('keeps connector credentials independent of the claim and private environment', () => {
    const credentials = { busUrl: 'wss://example/bus', busAuthSecret: 'secret' };
    expect(WorkerBootstrapCredentialsSchema.parse(credentials)).toEqual(credentials);
    expect(WorkerBootstrapCredentialsSchema.safeParse({ ...credentials, runtimeEnv: {} }).success).toBe(false);
    expect(WorkerBootstrapCredentialsSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('never carries private material on pending or refused responses', () => {
    const schema = WorkerSchemas['control.bootstrap.claim'].response;
    for (const reply of [{ status: 'pending' }, { status: 'refused', reason: 'not-claimable' }]) {
      expect(schema.parse(reply)).toEqual(reply);
      for (const extra of [
        { credentials: { busUrl: 'url', busAuthSecret: 'secret' } },
        { runtimeEnv: {} },
        { busAuthSecret: 'secret' },
      ]) {
        expect(schema.safeParse({ ...reply, ...extra }).success).toBe(false);
      }
    }
    for (const reason of [
      'not-found',
      'resolved',
      'fenced',
      'allocation-terminated',
      'gate-closed',
      'bootstrap-expired',
      'provider-mismatch',
      'claim-expired',
      'not-claimable',
    ]) {
      expect(schema.parse({ status: 'refused', reason })).toEqual({ status: 'refused', reason });
    }
    expect(schema.safeParse({ status: 'refused' }).success).toBe(false);
    expect(schema.safeParse({ status: 'refused', reason: 'secret-value' }).success).toBe(false);
    expect(schema.safeParse({ status: 'granted', runtimeEnv: {} }).success).toBe(false);
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

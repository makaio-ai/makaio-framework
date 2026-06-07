import { describe, expect, it } from 'vitest';
import { WorkerNodeSchemas } from '../schemas.js';

describe('WorkerNode bootstrap claim schema', () => {
  it('validates execution-scoped bootstrap claims and responses', () => {
    const request = WorkerNodeSchemas['control.bootstrap.claim'].request.parse({
      executionId: 'exec-1',
      nodeId: 'node-1',
      bootstrapSecret: 'repo-bootstrap-secret',
    });
    const response = WorkerNodeSchemas['control.bootstrap.claim'].response.parse({
      busUrl: 'wss://makaio-server.example/bus',
      busAuthSecret: 'execution-secret',
    });

    expect(request.nodeId).toBe('node-1');
    expect(response.busAuthSecret).toBe('execution-secret');
  });

  it('rejects bootstrap claim request with unknown fields', () => {
    expect(() =>
      WorkerNodeSchemas['control.bootstrap.claim'].request.parse({
        executionId: 'exec-1',
        nodeId: 'node-1',
        bootstrapSecret: 'secret',
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('rejects bootstrap claim response with unknown fields', () => {
    expect(() =>
      WorkerNodeSchemas['control.bootstrap.claim'].response.parse({
        busUrl: 'wss://example/bus',
        busAuthSecret: 'secret',
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('rejects bootstrap claim request with empty strings', () => {
    expect(() =>
      WorkerNodeSchemas['control.bootstrap.claim'].request.parse({
        executionId: '',
        nodeId: 'node-1',
        bootstrapSecret: 'secret',
      }),
    ).toThrow();
  });

  it('validates worker result control events', () => {
    const result = WorkerNodeSchemas['control.result'].parse({
      executionId: 'exec-1',
      nodeId: 'node-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'failed',
        error: 'adapter failed',
      },
    });

    expect(result.result).toMatchObject({ status: 'failed', error: 'adapter failed' });
  });

  it('validates completed result variant in control.result', () => {
    const result = WorkerNodeSchemas['control.result'].parse({
      executionId: 'exec-1',
      nodeId: 'node-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'completed',
      },
    });

    expect(result.result.status).toBe('completed');
    expect(result.nodeId).toBe('node-1');
  });

  it('validates cancelled result variant in control.result', () => {
    const result = WorkerNodeSchemas['control.result'].parse({
      executionId: 'exec-1',
      nodeId: 'node-1',
      result: {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        status: 'cancelled',
        reason: 'user requested cancellation',
      },
    });

    expect(result.result.status).toBe('cancelled');
  });

  it('rejects control.result with unknown top-level fields', () => {
    expect(() =>
      WorkerNodeSchemas['control.result'].parse({
        executionId: 'exec-1',
        nodeId: 'node-1',
        result: {
          executionId: 'exec-1',
          workflowId: 'wf-1',
          status: 'completed',
        },
        unknownField: 'should-fail',
      }),
    ).toThrow();
  });

  it('rejects control.result when envelope and result execution IDs differ', () => {
    expect(() =>
      WorkerNodeSchemas['control.result'].parse({
        executionId: 'exec-1',
        nodeId: 'node-1',
        result: {
          executionId: 'exec-2',
          workflowId: 'wf-1',
          status: 'completed',
        },
      }),
    ).toThrow(/result.executionId/);
  });
});

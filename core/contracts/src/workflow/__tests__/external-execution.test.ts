import { describe, expect, it } from 'vitest';
import {
  CompleteExternalExecutionRequestSchema,
  RegisterExternalExecutionRequestSchema,
} from '../external-execution.js';
import { WorkflowSchemas, WorkflowSubjects } from '../namespace.js';

describe('external execution contracts', () => {
  it('accepts idempotent registration identity and exact frame start metadata', () => {
    const request = RegisterExternalExecutionRequestSchema.parse({
      executionId: 'wfx-ext-direct-review-1',
      name: 'direct-review',
      startedAt: 1_000,
      frame: {
        nodeId: 'review',
        nodeType: 'delegate-role',
        path: ['review'],
        startedAt: 1_010,
      },
    });

    expect(request.frame?.attempt).toBe(0);
    expect(WorkflowSubjects.registerExternalExecution.subject).toBe('registerExternalExecution');
    expect(WorkflowSchemas.registerExternalExecution.request.parse(request)).toEqual(request);
  });

  it('rejects caller-supplied IDs outside the external execution namespace', () => {
    expect(() =>
      RegisterExternalExecutionRequestSchema.parse({ executionId: 'wfx-engine-owned', name: 'direct-review' }),
    ).toThrow('wfx-ext-');
  });

  it('accepts an exact frame settlement and validates its timestamps', () => {
    const settlement = {
      executionId: 'wfx-ext-direct-review-1',
      status: 'completed' as const,
      completedAt: 1_250,
      frame: {
        frameId: 'wfx-ext-direct-review-1:review',
        nodeId: 'review',
        nodeType: 'delegate-role' as const,
        path: ['review'],
        startedAt: 1_000,
        durationMs: 250,
      },
    };

    expect(CompleteExternalExecutionRequestSchema.parse(settlement).frame?.attempt).toBe(0);
    expect(WorkflowSchemas.completeExternalExecution.request.parse(settlement)).toMatchObject(settlement);
  });

  it('requires a timestamp for frame settlement and rejects inconsistent duration', () => {
    const frame = {
      frameId: 'wfx-ext-direct-review-1:review',
      nodeId: 'review',
      nodeType: 'delegate-role' as const,
      path: ['review'],
      startedAt: 1_000,
      durationMs: 100,
    };
    expect(() =>
      CompleteExternalExecutionRequestSchema.parse({
        executionId: 'wfx-ext-direct-review-1',
        status: 'completed',
        frame,
      }),
    ).toThrow('completedAt is required');
    expect(() =>
      CompleteExternalExecutionRequestSchema.parse({
        executionId: 'wfx-ext-direct-review-1',
        status: 'completed',
        completedAt: 1_250,
        frame,
      }),
    ).toThrow('durationMs must equal');
  });
});

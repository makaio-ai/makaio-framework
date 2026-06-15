import { describe, expect, it } from 'vitest';
import { CrudSchemas } from '../schemas/crud.js';

describe('CrudSchemas.create', () => {
  it('accepts JSON-safe session metadata', () => {
    const result = CrudSchemas.create.request.safeParse({
      metadata: {
        downstream: {
          workflowId: 'workflow-1',
          attempt: 2,
          active: true,
          labels: ['station-a'],
          optional: null,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects non-JSON session metadata values', () => {
    const result = CrudSchemas.create.request.safeParse({
      metadata: {
        invalid: undefined,
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts spawningToolCallId for subagent sessions', () => {
    const result = CrudSchemas.create.request.safeParse({
      branchKind: 'subagent',
      spawningToolCallId: 'tool-call-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects spawningToolCallId for non-subagent sessions', () => {
    const result = CrudSchemas.create.request.safeParse({
      branchKind: 'fork',
      spawningToolCallId: 'tool-call-1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['spawningToolCallId'],
        message: 'spawningToolCallId is only valid for subagent sessions',
      }),
    );
  });
});

describe('CrudSchemas.update', () => {
  it('accepts metadata replacement and clear payloads', () => {
    expect(
      CrudSchemas.update.request.safeParse({
        sessionId: 'session-1',
        metadata: { correlationId: 'downstream-1' },
      }).success,
    ).toBe(true);

    expect(
      CrudSchemas.update.request.safeParse({
        sessionId: 'session-1',
        metadata: null,
      }).success,
    ).toBe(true);
  });
});

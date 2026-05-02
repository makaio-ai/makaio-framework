import { describe, expect, it } from 'vitest';
import { CrudSchemas } from '../schemas/crud.js';

describe('CrudSchemas.create', () => {
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

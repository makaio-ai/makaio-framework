import { describe, expect, it } from 'vitest';
import type { CodeExecutionRequest } from '@makaio/contracts';
import { requestAdmissionFailure } from '../request-admission.js';

const request = (argumentsValue: CodeExecutionRequest['arguments'], exportName = 'handler'): CodeExecutionRequest => ({
  invocationId: 'request-admission-test',
  program: {
    files: { 'entry.ts': 'export const handler = (): null => null;' },
    entryFile: 'entry.ts',
    exportName,
  },
  arguments: argumentsValue,
  timeoutMs: 1_000,
});

describe('requestAdmissionFailure', () => {
  it('classifies an empty direct-call export name as invalid_program', () => {
    expect(requestAdmissionFailure(request(null, ''), 1_024)).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_program', message: expect.stringContaining('must not be empty') },
    });
  });

  it('classifies a cyclic direct-call argument as invalid_program', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(requestAdmissionFailure(request(cyclic), 1_024)).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_program', message: expect.stringContaining('cyclic reference') },
    });
  });

  it('classifies negative zero in a direct-call argument as invalid_program', () => {
    expect(requestAdmissionFailure(request({ nested: -0 }), 1_024)).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_program', message: expect.stringContaining('-0') },
    });
  });

  it('uses the one getter read for its size measurement', () => {
    let reads = 0;
    const argument: Record<string, unknown> = {};
    Object.defineProperty(argument, 'value', {
      enumerable: true,
      get: (): string => {
        reads += 1;
        return 'ok';
      },
    });

    expect(requestAdmissionFailure(request(argument), 1_024)).toBeUndefined();
    expect(reads).toBe(1);
  });
});

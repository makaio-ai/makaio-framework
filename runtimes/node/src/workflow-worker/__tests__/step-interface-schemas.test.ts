import { describe, expect, it } from 'vitest';
import {
  StepProcessLaunchRequestSchema,
  StepRequestCallRequestSchema,
  StepRequestCallResultSchema,
} from '../step-interface-schemas.js';

describe('step interface requests', () => {
  it('accepts a launch without allowing the step to select worker policy', () => {
    const params = { program: 'example-program', args: ['--version'], cwd: '.', stdin: 'none' };
    const launch = { jsonrpc: '2.0', id: 1, method: 'process.launch', params };
    expect(StepProcessLaunchRequestSchema.parse(launch)).toEqual(launch);
    for (const policy of [{ env: {} }, { owner: 'another-step' }, { timeoutMs: 3000 }]) {
      expect(StepProcessLaunchRequestSchema.safeParse({ ...launch, params: { ...params, ...policy } }).success).toBe(
        false,
      );
    }
  });

  it('preserves request data while keeping the step identity outside the payload envelope', () => {
    const params = { subject: 'example.lookup', payload: { key: 'value' } };
    const request = { jsonrpc: '2.0', id: 'lookup', method: 'request.call', params };
    expect(StepRequestCallRequestSchema.parse(request)).toEqual(request);
    expect(
      StepRequestCallRequestSchema.safeParse({
        ...request,
        params: { ...params, stepId: 'other' },
      }).success,
    ).toBe(false);
  });

  it('distinguishes a missing grant from a rejected or failed request', () => {
    const refusal = { ok: false, code: 'request-not-granted' };
    expect(StepRequestCallResultSchema.parse(refusal)).toEqual(refusal);
    expect(StepRequestCallResultSchema.safeParse({ ok: false, code: 'makaio.step-invalid-request' }).success).toBe(
      false,
    );
    expect(StepRequestCallResultSchema.safeParse({ ...refusal, response: null }).success).toBe(false);
    expect(StepRequestCallResultSchema.parse({ ok: true, response: null })).toEqual({ ok: true, response: null });
  });
});

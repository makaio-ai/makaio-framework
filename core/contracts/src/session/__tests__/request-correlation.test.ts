import { describe, expect, it } from 'vitest';
import { RequestCorrelationContextSchema, SessionContextSchema } from '../../index.js';

describe('RequestCorrelationContextSchema', () => {
  it('accepts only the documented content-free identifiers', () => {
    expect(
      SessionContextSchema.parse({
        turnContext: { visibleToModel: 'yes' },
        requestCorrelation: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          messageId: 'message-1',
          executionId: 'execution-1',
          frameId: 'frame-1',
        },
      }),
    ).toEqual({
      turnContext: { visibleToModel: 'yes' },
      requestCorrelation: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        messageId: 'message-1',
        executionId: 'execution-1',
        frameId: 'frame-1',
      },
    });
  });

  it('rejects content and oversized identifiers', () => {
    expect(RequestCorrelationContextSchema.safeParse({ prompt: 'do not transport this' }).success).toBe(false);
    expect(RequestCorrelationContextSchema.safeParse({ executionId: 'x'.repeat(513) }).success).toBe(false);
  });

  it('trims identifiers but rejects values that Node cannot place in headers', () => {
    expect(RequestCorrelationContextSchema.parse({ executionId: '  execution-1  ' })).toEqual({
      executionId: 'execution-1',
    });

    for (const field of ['sessionId', 'turnId', 'messageId', 'executionId', 'frameId'] as const) {
      for (const value of [
        'safe\r\ninjected',
        'safe\u0000value',
        'safe\u007fvalue',
        'safe\u0085value',
        'safe\u2028value',
        'safe-😀',
      ]) {
        expect(RequestCorrelationContextSchema.safeParse({ [field]: value }).success, `${field}: ${value}`).toBe(false);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { AgentInterruptSchema } from '../interrupt.js';

describe('AgentInterruptSchema.response', () => {
  it('accepts successful interrupt responses without a reason', () => {
    const result = AgentInterruptSchema.response.safeParse({ success: true });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: true });
  });

  it('omits reason from successful interrupt responses', () => {
    const result = AgentInterruptSchema.response.safeParse({ success: true, reason: 'ignored' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: true });
  });

  it('requires a non-empty reason for rejected interrupt responses', () => {
    expect(AgentInterruptSchema.response.safeParse({ success: false }).success).toBe(false);
    expect(AgentInterruptSchema.response.safeParse({ success: false, reason: '' }).success).toBe(false);
    expect(AgentInterruptSchema.response.safeParse({ success: false, reason: 'not active' }).success).toBe(true);
  });
});

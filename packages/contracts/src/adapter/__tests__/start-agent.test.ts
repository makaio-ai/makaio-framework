import { describe, expect, it } from 'vitest';
import { StartAgentSchema } from '../schemas/start-agent.js';

describe('StartAgentSchema', () => {
  it('allows ephemeral agents only for create-mode requests', () => {
    expect(
      StartAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        role: 'lead',
        initialMessage: 'hello',
        ephemeral: true,
      }).success,
    ).toBe(true);
    expect(
      StartAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        role: 'lead',
        mode: 'create',
        initialMessage: 'hello',
        ephemeral: true,
      }).success,
    ).toBe(true);

    expect(
      StartAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        role: 'lead',
        mode: 'create',
        ephemeral: true,
      }).success,
    ).toBe(false);

    expect(
      StartAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        role: 'lead',
        mode: 'resume',
        sessionId: 'session-1',
        adapterSessionId: 'adapter-session-1',
        initialMessage: 'hello',
        ephemeral: true,
      }).success,
    ).toBe(false);
    expect(
      StartAgentSchema.request.safeParse({
        adapterId: 'adapter-1',
        role: 'lead',
        mode: 'fork',
        sessionId: 'session-1',
        sourceSessionId: 'source-session-1',
        initialMessage: 'hello',
        ephemeral: true,
      }).success,
    ).toBe(false);
  });
});

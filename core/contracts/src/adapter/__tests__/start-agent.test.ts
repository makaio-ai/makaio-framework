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
        sourceAdapterSessionId: 'adapter-source',
        initialMessage: 'hello',
        ephemeral: true,
      }).success,
    ).toBe(false);
  });

  it('accepts responseSchema on start requests', () => {
    const parsed = StartAgentSchema.request.safeParse({
      adapterId: 'adapter-1',
      role: 'lead',
      initialMessage: 'hello',
      responseSchema: {
        schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
        name: 'approved_schema',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('preserves JSON-safe adapterConfig on start requests', () => {
    const parsed = StartAgentSchema.request.parse({
      adapterId: 'adapter-1',
      role: 'lead',
      initialMessage: 'hello',
      adapterConfig: {
        queryOptions: {
          maxTurns: 3,
          permissionMode: 'acceptEdits',
        },
      },
    });

    expect(parsed).toMatchObject({
      adapterConfig: {
        queryOptions: {
          maxTurns: 3,
          permissionMode: 'acceptEdits',
        },
      },
    });
  });

  it('rejects non-JSON adapterConfig values', () => {
    const parsed = StartAgentSchema.request.safeParse({
      adapterId: 'adapter-1',
      role: 'lead',
      initialMessage: 'hello',
      adapterConfig: {
        queryOptions: {
          maxTurns: undefined,
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a native fork start request with source adapter session identity', () => {
    const parsed = StartAgentSchema.request.parse({
      mode: 'fork',
      adapterId: 'adapter-1',
      sessionId: 'child-session',
      sourceSessionId: 'source-session',
      sourceAdapterSessionId: 'adapter-source',
      role: 'lead',
      initialMessage: 'continue on the fork',
    });

    // Narrow to fork variant to access fork-specific fields
    expect(parsed.mode).toBe('fork');
    expect((parsed as { sourceAdapterSessionId: string }).sourceAdapterSessionId).toBe('adapter-source');
  });

  it('requires an exact owner on successful start responses', () => {
    const response = {
      success: true,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      sessionId: 'session-1',
    };

    expect(StartAgentSchema.response.safeParse(response).success).toBe(false);
    expect(StartAgentSchema.response.safeParse({ ...response, ownerInstanceId: 'runtime-1' }).success).toBe(true);
  });
});

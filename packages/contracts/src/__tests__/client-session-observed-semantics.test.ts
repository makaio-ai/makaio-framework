import { describe, expect, it } from 'vitest';
import {
  ClientSessionObservedBaseSchema,
  ClientSessionStartedSchema,
  ClientSessionToolPostSchema,
  ClientSessionToolPreSchema,
  ClientSessionTurnCompletedSchema,
  ClientSessionTurnStartedSchema,
  ClientSessionUserPromptSubmittedSchema,
  ClientSubjects,
} from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Shared fixture — minimal valid base payload
// ---------------------------------------------------------------------------

function makeBase(overrides?: Record<string, unknown>) {
  return {
    clientId: 'claude-code',
    source: 'native-hook',
    observedAt: 1_713_795_200_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Subject registration
// ---------------------------------------------------------------------------

describe('ClientSubjects — observed session semantics', () => {
  it('exposes client.session.started with the correct subject and namespace', () => {
    expect(ClientSubjects.session.started.subject).toBe('session.started');
    expect(ClientSubjects.session.started.$meta.namespace).toBe('client');
  });

  it('exposes client.session.userPrompt.submitted with the correct subject and namespace', () => {
    expect(ClientSubjects.session.userPrompt.submitted.subject).toBe('session.userPrompt.submitted');
    expect(ClientSubjects.session.userPrompt.submitted.$meta.namespace).toBe('client');
  });

  it('exposes client.session.turn.started with the correct subject and namespace', () => {
    expect(ClientSubjects.session.turn.started.subject).toBe('session.turn.started');
    expect(ClientSubjects.session.turn.started.$meta.namespace).toBe('client');
  });

  // RS-5: registration metadata assertion — event (not request) classification
  it('registers client.session.turn.started as a fire-and-forget event (not a request)', () => {
    expect(ClientSubjects.session.turn.started.$meta.isRequest).toBe(false);
  });

  it('exposes client.session.turn.completed with the correct subject and namespace', () => {
    expect(ClientSubjects.session.turn.completed.subject).toBe('session.turn.completed');
    expect(ClientSubjects.session.turn.completed.$meta.namespace).toBe('client');
  });

  it('exposes client.session.tool.pre with the correct subject and namespace', () => {
    expect(ClientSubjects.session.tool.pre.subject).toBe('session.tool.pre');
    expect(ClientSubjects.session.tool.pre.$meta.namespace).toBe('client');
  });

  it('exposes client.session.tool.post with the correct subject and namespace', () => {
    expect(ClientSubjects.session.tool.post.subject).toBe('session.tool.post');
    expect(ClientSubjects.session.tool.post.$meta.namespace).toBe('client');
  });

  it('does not collide with the existing session.account.observe subject', () => {
    expect(ClientSubjects.session.account.observe.subject).toBe('session.account.observe');
  });
});

// ---------------------------------------------------------------------------
// Base schema validation
// ---------------------------------------------------------------------------

describe('ClientSessionObservedBaseSchema', () => {
  it('accepts a minimal payload with only required fields', () => {
    const result = ClientSessionObservedBaseSchema.safeParse(makeBase());

    expect(result.success).toBe(true);
  });

  it('accepts optional fields when provided', () => {
    const result = ClientSessionObservedBaseSchema.parse(
      makeBase({
        sessionId: 'session-1',
        adapterSessionId: 'adapter-session-1',
        metadata: { extra: 'value' },
      }),
    );

    expect(result.sessionId).toBe('session-1');
    expect(result.adapterSessionId).toBe('adapter-session-1');
    expect(result.metadata).toEqual({ extra: 'value' });
  });

  it('rejects a negative observedAt timestamp', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ observedAt: -1 })).success).toBe(false);
  });

  it('rejects a non-integer observedAt timestamp', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ observedAt: 1_713_795_200.5 })).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(ClientSessionObservedBaseSchema.safeParse({}).success).toBe(false);
    expect(ClientSessionObservedBaseSchema.safeParse({ clientId: 'claude-code', observedAt: 0 }).success).toBe(false);
  });

  it('rejects an empty clientId', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ clientId: '' })).success).toBe(false);
  });

  it('rejects a whitespace-only clientId', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ clientId: '   ' })).success).toBe(false);
  });

  it('rejects an empty source', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ source: '' })).success).toBe(false);
  });

  it('rejects a whitespace-only source', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ source: '   ' })).success).toBe(false);
  });

  it('rejects a non-finite observedAt timestamp', () => {
    expect(ClientSessionObservedBaseSchema.safeParse(makeBase({ observedAt: Infinity })).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.session.started
// ---------------------------------------------------------------------------

describe('ClientSessionStartedSchema', () => {
  it('accepts a valid started payload', () => {
    expect(ClientSessionStartedSchema.safeParse(makeBase()).success).toBe(true);
  });

  it('rejects a payload missing required fields', () => {
    expect(ClientSessionStartedSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.session.userPrompt.submitted
// ---------------------------------------------------------------------------

describe('ClientSessionUserPromptSubmittedSchema', () => {
  it('accepts a payload without a prompt', () => {
    expect(ClientSessionUserPromptSubmittedSchema.safeParse(makeBase()).success).toBe(true);
  });

  it('accepts a payload with a prompt', () => {
    const result = ClientSessionUserPromptSubmittedSchema.parse(makeBase({ prompt: 'Fix the lint error' }));

    expect(result.prompt).toBe('Fix the lint error');
  });
});

// ---------------------------------------------------------------------------
// client.session.turn.started
// ---------------------------------------------------------------------------

describe('ClientSessionTurnStartedSchema', () => {
  it('accepts a valid turn-started payload', () => {
    expect(ClientSessionTurnStartedSchema.safeParse(makeBase()).success).toBe(true);
  });

  it('rejects a payload missing required fields', () => {
    expect(ClientSessionTurnStartedSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.session.turn.completed
// ---------------------------------------------------------------------------

describe('ClientSessionTurnCompletedSchema', () => {
  it('accepts a valid turn-completed payload', () => {
    expect(ClientSessionTurnCompletedSchema.safeParse(makeBase()).success).toBe(true);
  });

  it('rejects a payload missing required fields', () => {
    expect(ClientSessionTurnCompletedSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.session.tool.pre
// ---------------------------------------------------------------------------

describe('ClientSessionToolPreSchema', () => {
  it('accepts a payload without tool identification fields', () => {
    expect(ClientSessionToolPreSchema.safeParse(makeBase()).success).toBe(true);
  });

  it('accepts a payload with toolName and toolCallId', () => {
    const result = ClientSessionToolPreSchema.parse(makeBase({ toolName: 'bash', toolCallId: 'call-abc-123' }));

    expect(result.toolName).toBe('bash');
    expect(result.toolCallId).toBe('call-abc-123');
  });
});

// ---------------------------------------------------------------------------
// client.session.tool.post
// ---------------------------------------------------------------------------

describe('ClientSessionToolPostSchema', () => {
  it('accepts a payload without tool identification or success fields', () => {
    expect(ClientSessionToolPostSchema.safeParse(makeBase()).success).toBe(true);
  });

  it('accepts a payload with all optional fields', () => {
    const result = ClientSessionToolPostSchema.parse(
      makeBase({ toolName: 'bash', toolCallId: 'call-abc-123', success: true }),
    );

    expect(result.toolName).toBe('bash');
    expect(result.toolCallId).toBe('call-abc-123');
    expect(result.success).toBe(true);
  });

  it('accepts a failed tool-call observation', () => {
    const result = ClientSessionToolPostSchema.parse(
      makeBase({ toolName: 'bash', toolCallId: 'call-abc-123', success: false }),
    );

    expect(result.success).toBe(false);
  });
});

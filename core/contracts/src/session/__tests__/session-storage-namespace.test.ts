import { describe, expect, it } from 'vitest';
import { SessionStorageSetRequestSchema, SessionStorageSetSessionSchema } from '../session-storage-namespace.js';

describe('SessionStorageSetSessionSchema', () => {
  it('rejects linked sessions without clientId', () => {
    const result = SessionStorageSetSessionSchema.safeParse({
      sessionId: 'session-1',
      createdAt: 1,
      lastActivityAt: 1,
      agents: [],
      status: 'active',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account.observe',
        observedAt: 1,
        payload: {
          displayLabel: 'Chris',
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['clientId'],
        message: 'clientId is required when clientAccountId is provided',
      }),
    );
  });
});

describe('SessionStorageSetRequestSchema', () => {
  it('rejects non-boolean ifAbsent values', () => {
    const result = SessionStorageSetRequestSchema.safeParse({
      sessionId: 'session-1',
      session: {
        sessionId: 'session-1',
        createdAt: 1,
        lastActivityAt: 1,
        agents: [],
        status: 'active',
      },
      ifAbsent: 'yes',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['ifAbsent'],
      }),
    );
  });
});

import { describe, expect, it } from 'bun:test';
import { ClientIdentityObservationSchema } from '@makaio/contracts/client';
import {
  MakaioSessionSchema,
  SessionSchemas,
  SessionStorageUpdateSchema,
  SessionSubjects,
} from '@makaio/contracts/session';

describe('SessionSubjects.clientAccount.changed', () => {
  it('exposes the session.clientAccount.changed subject', () => {
    expect(SessionSubjects.clientAccount.changed.subject).toBe('clientAccount.changed');
    expect(SessionSubjects.clientAccount.changed.$meta.namespace).toBe('session');
  });

  it('validates session.clientAccount.changed payloads', () => {
    const observation = ClientIdentityObservationSchema.parse({
      clientId: 'claude-code',
      source: 'statusline',
      kind: 'account-profile',
      observedAt: 1_713_795_200_000,
      payload: {
        email: 'user@example.com',
      },
    });

    expect(
      SessionSchemas['clientAccount.changed'].parse({
        sessionId: 'session-1',
        clientId: 'claude-code',
        previousClientAccountId: null,
        clientAccountId: 'client-account-1',
        source: 'statusline',
        observedAt: 1_713_795_200_000,
        lastClientIdentityObservation: observation,
      }),
    ).toEqual({
      sessionId: 'session-1',
      clientId: 'claude-code',
      previousClientAccountId: null,
      clientAccountId: 'client-account-1',
      source: 'statusline',
      observedAt: 1_713_795_200_000,
      lastClientIdentityObservation: observation,
    });
  });
});

describe('Session client identity storage alignment', () => {
  it('accepts client identity fields on the session entity', () => {
    const observation = ClientIdentityObservationSchema.parse({
      clientId: 'claude-code',
      source: 'statusline',
      kind: 'account-profile',
      observedAt: 1_713_795_200_000,
      payload: {
        email: 'user@example.com',
      },
    });

    expect(
      MakaioSessionSchema.parse({
        sessionId: 'session-1',
        createdAt: 1,
        lastActivityAt: 2,
        agents: [],
        status: 'active',
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: observation,
      }),
    ).toEqual(
      expect.objectContaining({
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: observation,
      }),
    );
  });

  it('allows storage:session.update to patch client identity linkage fields', () => {
    expect(
      SessionStorageUpdateSchema.request.parse({
        sessionId: 'session-1',
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: {
          clientId: 'claude-code',
          source: 'statusline',
          kind: 'account-profile',
          observedAt: 1_713_795_200_000,
          payload: {
            email: 'user@example.com',
          },
        },
      }),
    ).toEqual({
      sessionId: 'session-1',
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'statusline',
        kind: 'account-profile',
        observedAt: 1_713_795_200_000,
        payload: {
          email: 'user@example.com',
        },
      },
    });
  });
});

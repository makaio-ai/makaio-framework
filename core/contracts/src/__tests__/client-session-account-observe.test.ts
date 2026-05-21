import { describe, expect, it } from 'vitest';
import {
  ClientAccountIdentifierSchema,
  ClientIdentityObservationSchema,
  ClientSessionAccountObserveSchema,
  ClientSessionLocatorSchema,
  ClientSubjects,
} from '@makaio/contracts/client';

describe('ClientSubjects.session.account.observe', () => {
  it('exposes the client.session.account.observe subject through the public client API', () => {
    expect(ClientSubjects.session.account.observe.subject).toBe('session.account.observe');
    expect(ClientSubjects.session.account.observe.$meta.namespace).toBe('client');
  });

  it('validates session locators for session, adapter-session, and combined lookup', () => {
    expect(
      ClientSessionLocatorSchema.parse({
        kind: 'session',
        sessionId: 'session-1',
      }),
    ).toEqual({
      kind: 'session',
      sessionId: 'session-1',
    });

    expect(
      ClientSessionLocatorSchema.parse({
        kind: 'adapter-session',
        adapterSessionId: 'adapter-session-1',
      }),
    ).toEqual({
      kind: 'adapter-session',
      adapterSessionId: 'adapter-session-1',
    });

    expect(
      ClientSessionLocatorSchema.parse({
        kind: 'both',
        sessionId: 'session-1',
        adapterSessionId: 'adapter-session-1',
      }),
    ).toEqual({
      kind: 'both',
      sessionId: 'session-1',
      adapterSessionId: 'adapter-session-1',
    });

    expect(
      ClientSessionLocatorSchema.safeParse({
        kind: 'both',
        sessionId: 'session-1',
      }).success,
    ).toBe(false);
  });

  it('rejects empty session locator identifiers', () => {
    expect(
      ClientSessionLocatorSchema.safeParse({
        kind: 'session',
        sessionId: '',
      }).success,
    ).toBe(false);

    expect(
      ClientSessionLocatorSchema.safeParse({
        kind: 'adapter-session',
        adapterSessionId: '',
      }).success,
    ).toBe(false);

    expect(
      ClientSessionLocatorSchema.safeParse({
        kind: 'both',
        sessionId: '',
        adapterSessionId: 'adapter-session-1',
      }).success,
    ).toBe(false);

    expect(
      ClientSessionLocatorSchema.safeParse({
        kind: 'both',
        sessionId: 'session-1',
        adapterSessionId: '',
      }).success,
    ).toBe(false);
  });

  it('validates identity observations and session-scoped account observe requests', () => {
    const observation = ClientIdentityObservationSchema.parse({
      clientId: 'claude-code',
      source: 'statusline',
      kind: 'account-profile',
      observedAt: 1_713_795_200_000,
      payload: {
        email: 'user@example.com',
        orgId: 'org-1',
      },
    });

    const result = ClientSessionAccountObserveSchema.response.parse({
      handled: true,
      sessionId: 'session-1',
      clientAccountId: 'client-account-1',
      changed: true,
    });

    expect(
      ClientSessionAccountObserveSchema.request.parse({
        locator: {
          kind: 'both',
          sessionId: 'session-1',
          adapterSessionId: 'adapter-session-1',
        },
        clientId: observation.clientId,
        source: observation.source,
        kind: observation.kind,
        observedAt: observation.observedAt,
        payload: observation.payload,
      }),
    ).toEqual({
      locator: {
        kind: 'both',
        sessionId: 'session-1',
        adapterSessionId: 'adapter-session-1',
      },
      clientId: 'claude-code',
      source: 'statusline',
      kind: 'account-profile',
      observedAt: 1_713_795_200_000,
      payload: {
        email: 'user@example.com',
        orgId: 'org-1',
      },
    });

    expect(result).toEqual({
      handled: true,
      sessionId: 'session-1',
      clientAccountId: 'client-account-1',
      changed: true,
    });
  });

  it('rejects non-JSON observation payload values', () => {
    expect(
      ClientIdentityObservationSchema.safeParse({
        clientId: 'claude-code',
        source: 'statusline',
        kind: 'account-profile',
        observedAt: 1_713_795_200_000,
        payload: {
          invalid: () => 'nope',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects empty canonical account identifier keys', () => {
    expect(
      ClientAccountIdentifierSchema.safeParse({
        scheme: '',
        value: 'acct-1:org-1',
        strength: 'strong',
      }).success,
    ).toBe(false);
    expect(
      ClientAccountIdentifierSchema.safeParse({
        scheme: 'account-org-uuid',
        value: '',
        strength: 'strong',
      }).success,
    ).toBe(false);
  });
});

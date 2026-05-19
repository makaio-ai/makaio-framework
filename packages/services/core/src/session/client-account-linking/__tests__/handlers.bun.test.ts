import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import {
  ClientSubjects,
  type ClientAccountObserveRequest,
  type ClientSessionAccountObserveRequest,
} from '@makaio/contracts/client';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { createSession, createTestDb } from '../../storage/__tests__/shared.js';
import { deriveClientAccountObservation } from '../handlers.js';
import { SessionClientAccountLinkingService } from '../index.js';

function createObservation(
  overrides: Partial<ClientSessionAccountObserveRequest> & Pick<ClientSessionAccountObserveRequest, 'locator'>,
): ClientSessionAccountObserveRequest {
  return {
    locator: overrides.locator,
    clientId: overrides.clientId ?? 'claude-code',
    source: overrides.source ?? 'claude-agent-sdk',
    kind: overrides.kind ?? 'account-info',
    observedAt: overrides.observedAt ?? 1_713_795_200_000,
    payload: overrides.payload ?? {
      displayLabel: 'Chris',
      identifiers: [
        {
          scheme: 'account-org-uuid',
          value: 'acct-1:org-1',
          strength: 'strong',
        },
      ],
    },
  };
}

function withoutLocator(request: ClientSessionAccountObserveRequest) {
  const { locator: _locator, ...observation } = request;
  return observation;
}

describe('SessionClientAccountLinkingService', () => {
  let cleanup: () => void;
  let service: SessionClientAccountLinkingService;

  beforeEach(async () => {
    const dbContext = await createTestDb();
    cleanup = dbContext.cleanup;
    service = new SessionClientAccountLinkingService(MakaioBus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    cleanup();
  });

  it('deep-clones nested observation payload fields before persistence normalization', () => {
    const request = createObservation({
      locator: { kind: 'session', sessionId: 'session-deep-clone-normalization' },
      payload: {
        displayLabel: 'Chris',
        accountInfo: {
          team: {
            slug: 'makaio',
          },
        },
        identifiers: [
          {
            scheme: 'account-org-uuid',
            value: 'acct-1:org-1',
            strength: 'strong',
          },
        ],
      },
    });

    const derived = deriveClientAccountObservation(request);
    const nestedPayload = request.payload.accountInfo as { team: { slug: string } };
    nestedPayload.team.slug = 'changed-after-normalization';
    (request.payload.identifiers as Array<{ value: string }>)[0].value = 'mutated';

    expect(derived.observation.payload).toEqual({
      displayLabel: 'Chris',
      accountInfo: {
        team: {
          slug: 'makaio',
        },
      },
      identifiers: [
        {
          scheme: 'account-org-uuid',
          value: 'acct-1:org-1',
          strength: 'strong',
        },
      ],
    });
  });

  it('resolves by sessionId and persists the linked client account state', async () => {
    const session = createSession({
      sessionId: 'session-by-id',
      adapterSessionId: 'adapter-session-by-id',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      expect(ctx.payload).toEqual<ClientAccountObserveRequest>({
        clientId: 'claude-code',
        observedAt: 1_713_795_200_000,
        displayLabel: 'Chris',
        identifiers: [
          {
            scheme: 'account-org-uuid',
            value: 'acct-1:org-1',
            strength: 'strong',
          },
        ],
      });
      ctx.setResult({ clientAccountId: 'client-account-1', displayLabel: 'Chris' });
    });

    try {
      const result = await MakaioBus.request(
        ClientSubjects.session.account.observe,
        createObservation({
          locator: { kind: 'session', sessionId: session.sessionId },
        }),
      );

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-1',
        changed: true,
      });

      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });

      expect(stored.session).toMatchObject({
        sessionId: session.sessionId,
        clientId: 'claude-code',
        clientAccountId: 'client-account-1',
        lastClientIdentityObservation: withoutLocator(
          createObservation({
            locator: { kind: 'session', sessionId: session.sessionId },
          }),
        ),
      });
    } finally {
      observeCleanup();
    }
  });

  it('resolves by adapterSessionId', async () => {
    const session = createSession({
      sessionId: 'session-by-adapter',
      adapterSessionId: 'adapter-session-by-adapter',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      expect(ctx.payload.clientId).toBe('claude-code');
      ctx.setResult({ clientAccountId: 'client-account-2' });
    });

    try {
      const result = await MakaioBus.request(
        ClientSubjects.session.account.observe,
        createObservation({
          locator: { kind: 'adapter-session', adapterSessionId: session.adapterSessionId! },
        }),
      );

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-2',
        changed: true,
      });
    } finally {
      observeCleanup();
    }
  });

  it('resolves by both locators when they point to the same session', async () => {
    const session = createSession({
      sessionId: 'session-by-both',
      adapterSessionId: 'adapter-session-by-both',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      ctx.setResult({ clientAccountId: 'client-account-3' });
    });

    try {
      const result = await MakaioBus.request(
        ClientSubjects.session.account.observe,
        createObservation({
          locator: {
            kind: 'both',
            sessionId: session.sessionId,
            adapterSessionId: session.adapterSessionId!,
          },
        }),
      );

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-3',
        changed: true,
      });
    } finally {
      observeCleanup();
    }
  });

  it('rejects when both locators resolve different sessions', async () => {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'session-mismatch-a',
      session: createSession({
        sessionId: 'session-mismatch-a',
        adapterSessionId: 'adapter-session-mismatch-a',
      }),
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'session-mismatch-b',
      session: createSession({
        sessionId: 'session-mismatch-b',
        adapterSessionId: 'adapter-session-mismatch-b',
      }),
    });

    const observeSpy = mock();
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      observeSpy(ctx.payload);
      ctx.setResult({ clientAccountId: 'unexpected' });
    });

    try {
      await expect(
        MakaioBus.request(
          ClientSubjects.session.account.observe,
          createObservation({
            locator: {
              kind: 'both',
              sessionId: 'session-mismatch-a',
              adapterSessionId: 'adapter-session-mismatch-b',
            },
          }),
        ),
      ).rejects.toThrow(/locator mismatch/i);
      expect(observeSpy).not.toHaveBeenCalled();
    } finally {
      observeCleanup();
    }
  });

  it('rejects when only one both-locator side resolves', async () => {
    const session = createSession({
      sessionId: 'session-partial-both',
      adapterSessionId: 'adapter-session-partial-both',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeSpy = mock();
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      observeSpy(ctx.payload);
      ctx.setResult({ clientAccountId: 'unexpected' });
    });

    try {
      await expect(
        MakaioBus.request(
          ClientSubjects.session.account.observe,
          createObservation({
            locator: {
              kind: 'both',
              sessionId: session.sessionId,
              adapterSessionId: 'missing-adapter-session',
            },
          }),
        ),
      ).rejects.toThrow(/session locator mismatch|must both resolve the same session/i);
      expect(observeSpy).not.toHaveBeenCalled();
    } finally {
      observeCleanup();
    }
  });

  it('returns handled false when no session can be resolved', async () => {
    const observeSpy = mock();
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      observeSpy(ctx.payload);
      ctx.setResult({ clientAccountId: 'unexpected' });
    });

    try {
      const result = await MakaioBus.request(
        ClientSubjects.session.account.observe,
        createObservation({
          locator: { kind: 'adapter-session', adapterSessionId: 'missing-adapter-session' },
        }),
      );

      expect(result).toEqual({
        handled: false,
        sessionId: null,
        clientAccountId: null,
        changed: false,
      });
      expect(observeSpy).not.toHaveBeenCalled();
    } finally {
      observeCleanup();
    }
  });

  it('returns handled false without mutating the session when the canonical account observer is unavailable', async () => {
    const session = createSession({
      sessionId: 'session-missing-account-observer',
      adapterSessionId: 'adapter-session-missing-account-observer',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const changedEvents: unknown[] = [];
    const eventCleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      changedEvents.push(ctx.payload);
    });

    const observation = createObservation({
      locator: { kind: 'session', sessionId: session.sessionId },
    });

    try {
      await expect(MakaioBus.request(ClientSubjects.session.account.observe, observation)).resolves.toEqual({
        handled: false,
        sessionId: session.sessionId,
        clientAccountId: null,
        changed: false,
      });

      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });

      expect(stored.session).toEqual(session);
      expect(changedEvents).toEqual([]);
    } finally {
      eventCleanup();
    }
  });

  it('requires canonical identifiers instead of deriving client-specific identifiers from raw payloads', async () => {
    const session = createSession({
      sessionId: 'session-without-identifiers',
      adapterSessionId: 'adapter-session-without-identifiers',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeSpy = mock();
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      observeSpy(ctx.payload);
      ctx.setResult({ clientAccountId: 'unexpected-client-account' });
    });

    try {
      await expect(
        MakaioBus.request(
          ClientSubjects.session.account.observe,
          createObservation({
            locator: { kind: 'session', sessionId: session.sessionId },
            payload: {
              accountInfo: {
                accountUuid: 'acct-1',
                orgUuid: 'org-1',
                displayLabel: 'Chris',
              },
            },
          }),
        ),
      ).rejects.toThrow(/canonical client account identifiers/i);
      expect(observeSpy).not.toHaveBeenCalled();

      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(stored.session?.clientAccountId).toBeUndefined();
      expect(stored.session?.lastClientIdentityObservation).toBeUndefined();
    } finally {
      observeCleanup();
    }
  });

  it('forwards explicit canonical identifiers without inventing client-specific schemes', async () => {
    const session = createSession({
      sessionId: 'session-explicit-identifiers',
      adapterSessionId: 'adapter-session-explicit-identifiers',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      expect(ctx.payload).toEqual<ClientAccountObserveRequest>({
        clientId: 'claude-code',
        observedAt: 1_713_795_200_000,
        displayLabel: 'Chris',
        identifiers: [
          {
            scheme: 'account-org-uuid',
            value: 'acct-1:org-1',
            strength: 'strong',
          },
        ],
      });
      ctx.setResult({ clientAccountId: 'client-account-explicit' });
    });

    try {
      const result = await MakaioBus.request(
        ClientSubjects.session.account.observe,
        createObservation({
          locator: { kind: 'session', sessionId: session.sessionId },
          payload: {
            accountInfo: {
              accountUuid: 'acct-1',
              orgUuid: 'org-1',
              displayLabel: 'Chris',
            },
            identifiers: [
              {
                scheme: 'account-org-uuid',
                value: 'acct-1:org-1',
                strength: 'strong',
              },
            ],
          },
        }),
      );

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-explicit',
        changed: true,
      });
    } finally {
      observeCleanup();
    }
  });

  it('rejects malformed explicit canonical identifiers without weakening the observation evidence', async () => {
    const session = createSession({
      sessionId: 'session-malformed-identifiers',
      adapterSessionId: 'adapter-session-malformed-identifiers',
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeSpy = mock();
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      observeSpy(ctx.payload);
      ctx.setResult({ clientAccountId: 'unexpected-client-account' });
    });

    try {
      await expect(
        MakaioBus.request(
          ClientSubjects.session.account.observe,
          createObservation({
            locator: { kind: 'session', sessionId: session.sessionId },
            payload: {
              displayLabel: 'Chris',
              identifiers: [
                {
                  scheme: 'account-org-uuid',
                  value: 'acct-1:org-1',
                  strength: 'strong',
                },
                {
                  scheme: '',
                  value: 'acct-2:org-2',
                  strength: 'strong',
                },
              ],
            },
          }),
        ),
      ).rejects.toThrow(/malformed canonical client account identifiers/i);
      expect(observeSpy).not.toHaveBeenCalled();

      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(stored.session?.clientAccountId).toBeUndefined();
      expect(stored.session?.lastClientIdentityObservation).toBeUndefined();
    } finally {
      observeCleanup();
    }
  });

  it('overwrites the observation without emitting changed when the client account stays stable', async () => {
    const session = createSession({
      sessionId: 'session-stable-account',
      adapterSessionId: 'adapter-session-stable-account',
      clientId: 'claude-code',
      clientAccountId: 'client-account-stable',
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account-info',
        observedAt: 1_713_795_199_000,
        payload: {
          displayLabel: 'Old Chris',
          identifiers: [
            {
              scheme: 'account-org-uuid',
              value: 'acct-1:org-1',
              strength: 'strong',
            },
          ],
        },
      },
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const changedEvents: unknown[] = [];
    const eventCleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      changedEvents.push(ctx.payload);
    });
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      ctx.setResult({ clientAccountId: 'client-account-stable' });
    });

    const nextObservation = createObservation({
      locator: { kind: 'session', sessionId: session.sessionId },
      observedAt: 1_713_795_201_000,
      payload: {
        displayLabel: 'New Chris',
        identifiers: [
          {
            scheme: 'account-org-uuid',
            value: 'acct-1:org-1',
            strength: 'strong',
          },
        ],
      },
    });

    try {
      const result = await MakaioBus.request(ClientSubjects.session.account.observe, nextObservation);

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-stable',
        changed: false,
      });
      expect(changedEvents).toEqual([]);

      const stored = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(stored.session?.lastClientIdentityObservation).toEqual(withoutLocator(nextObservation));
    } finally {
      observeCleanup();
      eventCleanup();
    }
  });

  it('emits session.clientAccount.changed with the full payload when the client account changes', async () => {
    const session = createSession({
      sessionId: 'session-changing-account',
      adapterSessionId: 'adapter-session-changing-account',
      clientId: 'claude-code',
      clientAccountId: 'client-account-old',
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account-info',
        observedAt: 1_713_795_199_000,
        payload: {
          displayLabel: 'Old Chris',
          identifiers: [
            {
              scheme: 'account-org-uuid',
              value: 'acct-0:org-0',
              strength: 'strong',
            },
          ],
        },
      },
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const changedEvents: unknown[] = [];
    const eventCleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      changedEvents.push(ctx.payload);
    });
    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      ctx.setResult({ clientAccountId: 'client-account-new' });
    });

    const observation = createObservation({
      locator: { kind: 'both', sessionId: session.sessionId, adapterSessionId: session.adapterSessionId! },
      observedAt: 1_713_795_202_000,
      payload: {
        displayLabel: 'Chris',
        identifiers: [
          {
            scheme: 'account-org-uuid',
            value: 'acct-1:org-1',
            strength: 'strong',
          },
        ],
      },
    });

    try {
      const result = await MakaioBus.request(ClientSubjects.session.account.observe, observation);

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-new',
        changed: true,
      });
      expect(changedEvents).toEqual([
        {
          sessionId: session.sessionId,
          clientId: 'claude-code',
          previousClientAccountId: 'client-account-old',
          clientAccountId: 'client-account-new',
          source: 'claude-agent-sdk',
          observedAt: 1_713_795_202_000,
          lastClientIdentityObservation: withoutLocator(observation),
        },
      ]);
    } finally {
      observeCleanup();
      eventCleanup();
    }
  });

  it('keeps the committed linkage when a session.clientAccount.changed subscriber fails', async () => {
    const session = createSession({
      sessionId: 'session-emit-failure',
      adapterSessionId: 'adapter-session-emit-failure',
      clientId: 'claude-code',
      clientAccountId: 'client-account-old',
      lastClientIdentityObservation: {
        clientId: 'claude-code',
        source: 'claude-agent-sdk',
        kind: 'account-info',
        observedAt: 1_713_795_199_000,
        payload: {
          displayLabel: 'Old Chris',
          identifiers: [
            {
              scheme: 'account-org-uuid',
              value: 'acct-0:org-0',
              strength: 'strong',
            },
          ],
        },
      },
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const observeCleanup = MakaioBus.on(ClientSubjects.account.observe, (ctx) => {
      ctx.setResult({ clientAccountId: 'client-account-new' });
    });
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const changedEvents: unknown[] = [];
    const successfulEventCleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, (ctx) => {
      changedEvents.push(ctx.payload);
    });
    const failingEventCleanup = MakaioBus.on(SessionSubjects.clientAccount.changed, () => {
      throw new Error('failed to emit changed event');
    });

    const observation = createObservation({
      locator: { kind: 'session', sessionId: session.sessionId },
      observedAt: 1_713_795_203_000,
      payload: {
        displayLabel: 'Chris',
        identifiers: [
          {
            scheme: 'account-org-uuid',
            value: 'acct-1:org-1',
            strength: 'strong',
          },
        ],
      },
    });

    try {
      const result = await MakaioBus.request(ClientSubjects.session.account.observe, observation);

      expect(result).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-new',
        changed: true,
      });
      expect(changedEvents).toEqual([
        {
          sessionId: session.sessionId,
          clientId: 'claude-code',
          previousClientAccountId: 'client-account-old',
          clientAccountId: 'client-account-new',
          source: 'claude-agent-sdk',
          observedAt: 1_713_795_203_000,
          lastClientIdentityObservation: withoutLocator(observation),
        },
      ]);

      const afterFailure = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(afterFailure.session).toMatchObject({
        clientId: 'claude-code',
        clientAccountId: 'client-account-new',
        lastClientIdentityObservation: withoutLocator(observation),
      });

      const retryResult = await MakaioBus.request(ClientSubjects.session.account.observe, observation);

      expect(retryResult).toEqual({
        handled: true,
        sessionId: session.sessionId,
        clientAccountId: 'client-account-new',
        changed: false,
      });
      expect(changedEvents).toHaveLength(1);
    } finally {
      failingEventCleanup();
      successfulEventCleanup();
      consoleError.mockRestore();
      observeCleanup();
    }
  });
});

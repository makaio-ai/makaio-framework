import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, type MessageResult } from '@makaio/ai-adapters-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import {
  ClientSessionAccountObserveSchema,
  ClientSubjects,
  type ClientSessionAccountObserveRequest,
} from '@makaio/contracts/client';
import type { ClaudeSessionConfig } from '../src/types/index.js';
import { createSessionAccountObservationRequester } from '../src/account-observation-requester.js';

const sessionHarness = vi.hoisted(() => {
  let currentConfig: ClaudeSessionConfig | undefined;
  let currentQueryInstance:
    | {
        accountInfo?: () => Promise<Record<string, unknown>>;
      }
    | undefined;
  let currentAdapterSessionId = 'adapter-session-1';

  class MockClaudeConnectorSession {
    public constructor(config: ClaudeSessionConfig) {
      currentConfig = config;
    }

    public async initialize(): Promise<void> {}

    public async getAdapterSessionId(): Promise<string> {
      return currentAdapterSessionId;
    }

    public getQueryInstance():
      | {
          accountInfo?: () => Promise<Record<string, unknown>>;
        }
      | undefined {
      return currentQueryInstance;
    }

    public async processQueue(): Promise<void> {}

    public async close(): Promise<void> {}

    public abort(): void {}

    public updateReasoningEffort(): void {}

    public async updateMcpServers(): Promise<void> {}
  }

  return {
    MockClaudeConnectorSession,
    setQueryInstance: (
      queryInstance:
        | {
            accountInfo?: () => Promise<Record<string, unknown>>;
          }
        | undefined,
    ) => {
      currentQueryInstance = queryInstance;
    },
    setAdapterSessionId: (adapterSessionId: string) => {
      currentAdapterSessionId = adapterSessionId;
    },
    fireTurnStart: (handle: MessageHandle) => {
      const onTurnStart = currentConfig?.onTurnStart;
      if (!onTurnStart) {
        throw new Error('ClaudeConnectorSession.onTurnStart was not wired');
      }
      onTurnStart(handle);
    },
    fireTurnComplete: (handle: MessageHandle, result: MessageResult) => {
      const onTurnComplete = currentConfig?.onTurnComplete;
      if (!onTurnComplete) {
        throw new Error('ClaudeConnectorSession.onTurnComplete was not wired');
      }
      // Match ClaudeConnectorSession: onTurnComplete is scheduled after handle
      // completion, so this harness must not await async observation work.
      onTurnComplete(handle, result);
    },
    reset: () => {
      currentConfig = undefined;
      currentQueryInstance = undefined;
      currentAdapterSessionId = 'adapter-session-1';
    },
  };
});

vi.mock('../src/session.js', () => ({
  ClaudeConnectorSession: sessionHarness.MockClaudeConnectorSession,
}));

import { ClaudeSdkConnector } from '../src/connector.js';
import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeCodeAdapterName } from '../src/constants.js';
import type { ClaudeAccountObservationPayload } from '../src/account-observation.js';

let connectors: ClaudeSdkConnector[] = [];

/**
 * Create and initialize a Claude SDK connector for tests.
 * @param sessionId - Makaio session ID to bind to the connector.
 * @returns Initialized connector instance.
 */
async function makeConnector(sessionId = 'session-1'): Promise<ClaudeSdkConnector> {
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  const connector = new ClaudeSdkConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: ClaudeCodeAdapterName,
    agentId: 'agent-test',
    sessionId,
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
    clientId: claudeClientDefinition.id,
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
  });
  await connector.initialize();
  connectors.push(connector);
  return connector;
}

/**
 * Create a message handle for turn-completion tests.
 * @param messageId - Message identifier to stamp onto the handle.
 * @returns Message handle instance.
 */
function createMessageHandle(messageId = 'message-1'): MessageHandle {
  return new MessageHandle(
    messageId,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    'enqueue',
  );
}

/**
 * Simulate a completed turn by invoking the connector's `onTurnComplete` seam.
 * @param connector - Connector instance under test.
 * @param result - Completion result to deliver.
 * @param messageId - Message identifier to attach to the synthetic handle.
 * @returns Message handle associated with the simulated turn after the hook is scheduled.
 */
async function fireTurnComplete(
  connector: ClaudeSdkConnector,
  result: MessageResult,
  messageId = 'message-1',
): Promise<MessageHandle> {
  const handle = createMessageHandle(messageId);
  sessionHarness.fireTurnStart(handle);
  sessionHarness.fireTurnComplete(handle, result);
  return handle;
}

// Real session-path coverage for the onTurnComplete seam lives in
// `session-on-turn-complete.test.ts`; this suite focuses on connector-side
// normalization, dedupe, and best-effort observation behavior.
describe('ClaudeSdkConnector account observation emission', () => {
  let cleanup: Array<() => void>;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    sessionHarness.reset();
    cleanup = [];
    connectors = [];
  });

  afterEach(async () => {
    await Promise.all(connectors.map(async (connector) => connector.close()));
    connectors = [];
    for (const fn of cleanup) {
      fn();
    }
    cleanup = [];
    vi.restoreAllMocks();
  });

  it('emits through the onTurnComplete session seam after successful completed turns', async () => {
    const connector = await makeConnector();
    sessionHarness.setAdapterSessionId('adapter-session-1');

    const accountInfo = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValueOnce({
        accountUuid: '11111111-1111-4111-8111-111111111111',
        orgUuid: '22222222-2222-4222-8222-222222222222',
        email: 'USER@example.com',
        organization: 'Org One',
        subscriptionType: 'Claude Team',
        apiProvider: 'firstParty',
      })
      .mockResolvedValueOnce({
        accountUuid: '11111111-1111-4111-8111-111111111111',
        orgUuid: '22222222-2222-4222-8222-222222222222',
        email: 'USER@example.com',
        organization: 'Org One',
        subscriptionType: 'Claude Max',
        apiProvider: 'firstParty',
      });
    sessionHarness.setQueryInstance({ accountInfo });

    const observations: ClientSessionAccountObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.session.account.observe, (ctx) => {
        observations.push(ClientSessionAccountObserveSchema.request.parse(ctx.payload));
        ctx.setResult({
          handled: true,
          sessionId: 'session-1',
          clientAccountId: 'client-account-1',
          changed: true,
        });
      }),
    );

    await fireTurnComplete(connector, { outcome: 'completed', result: { message: 'first' } }, 'message-1');
    await vi.waitFor(() => expect(observations).toHaveLength(1));

    await fireTurnComplete(connector, { outcome: 'completed', result: { message: 'second' } }, 'message-2');
    await vi.waitFor(() => expect(observations).toHaveLength(2));

    expect(accountInfo).toHaveBeenCalledTimes(2);
    expect(observations[0]).toMatchObject({
      locator: { kind: 'both', sessionId: 'session-1', adapterSessionId: 'adapter-session-1' },
      clientId: claudeClientDefinition.id,
      source: 'claude-agent-sdk',
      kind: 'account-info',
    });
    expect(observations[0]?.payload).toEqual<ClaudeAccountObservationPayload>({
      displayLabel: 'user@example.com',
      identifiers: [
        {
          scheme: 'account-org-uuid',
          value: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
          strength: 'strong',
        },
      ],
      accountInfo: {
        accountUuid: '11111111-1111-4111-8111-111111111111',
        orgUuid: '22222222-2222-4222-8222-222222222222',
        email: 'user@example.com',
        organization: 'Org One',
        subscriptionType: 'Claude Team',
        apiProvider: 'firstParty',
      },
    });
    expect(observations[1]?.payload).toEqual<ClaudeAccountObservationPayload>({
      displayLabel: 'user@example.com',
      identifiers: [
        {
          scheme: 'account-org-uuid',
          value: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
          strength: 'strong',
        },
      ],
      accountInfo: {
        accountUuid: '11111111-1111-4111-8111-111111111111',
        orgUuid: '22222222-2222-4222-8222-222222222222',
        email: 'user@example.com',
        organization: 'Org One',
        subscriptionType: 'Claude Max',
        apiProvider: 'firstParty',
      },
    });
  });

  it('does not emit when the turn result is not completed', async () => {
    const connector = await makeConnector();
    const accountInfo = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      email: 'USER@example.com',
      organization: 'Org One',
      subscriptionType: 'Claude Team',
      apiProvider: 'firstParty',
    });
    sessionHarness.setQueryInstance({ accountInfo });

    const observeSpy = vi.fn();
    cleanup.push(
      MakaioBus.on(ClientSubjects.session.account.observe, (ctx) => {
        observeSpy(ctx.payload);
        ctx.setResult({
          handled: true,
          sessionId: 'session-1',
          clientAccountId: 'client-account-1',
          changed: true,
        });
      }),
    );

    await fireTurnComplete(connector, { outcome: 'error', error: new Error('turn failed') });

    expect(accountInfo).not.toHaveBeenCalled();
    expect(observeSpy).not.toHaveBeenCalled();
  });

  it('keeps turn completion best-effort when client.session.account.observe throws', async () => {
    const connector = await makeConnector();
    const completedResult: MessageResult = { outcome: 'completed', result: { message: 'done' } };
    const requestOptionalSpy = vi
      .spyOn(MakaioBus, 'requestOptional')
      .mockRejectedValueOnce(new Error('account observation failed'));

    sessionHarness.setQueryInstance({
      accountInfo: vi.fn().mockResolvedValue({
        accountUuid: '33333333-3333-4333-8333-333333333333',
        orgUuid: '44444444-4444-4444-8444-444444444444',
        email: 'USER@example.com',
      }),
    });

    const handle = await fireTurnComplete(connector, completedResult);

    await vi.waitFor(() => {
      expect(requestOptionalSpy).toHaveBeenCalledWith(
        ClientSubjects.session.account.observe,
        expect.objectContaining({
          clientId: claudeClientDefinition.id,
          source: 'claude-agent-sdk',
          kind: 'account-info',
        }),
      );
    });

    expect(handle).toBeInstanceOf(MessageHandle);
  });

  it('does not emit canonical account observations from email-only Claude evidence', async () => {
    const connector = await makeConnector();
    const accountInfo = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      email: 'USER@example.com',
      organization: 'Org One',
      subscriptionType: 'Claude Team',
      apiProvider: 'firstParty',
    });
    sessionHarness.setQueryInstance({ accountInfo });

    const observeSpy = vi.fn();
    cleanup.push(
      MakaioBus.on(ClientSubjects.session.account.observe, (ctx) => {
        observeSpy(ctx.payload);
        ctx.setResult({
          handled: true,
          sessionId: 'session-1',
          clientAccountId: 'client-account-1',
          changed: true,
        });
      }),
    );

    await fireTurnComplete(connector, { outcome: 'completed', result: { message: 'done' } });
    await Promise.resolve();

    expect(accountInfo).toHaveBeenCalledTimes(1);
    expect(observeSpy).not.toHaveBeenCalled();
  });

  it('retries the same observation when the session linker declines to handle it', async () => {
    const connector = await makeConnector();
    sessionHarness.setAdapterSessionId('adapter-session-1');

    const accountInfo = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      accountUuid: '55555555-5555-4555-8555-555555555555',
      orgUuid: '66666666-6666-4666-8666-666666666666',
      email: 'USER@example.com',
      organization: 'Org Retry',
      subscriptionType: 'Claude Team',
      apiProvider: 'firstParty',
    });
    sessionHarness.setQueryInstance({ accountInfo });

    const observations: ClientSessionAccountObserveRequest[] = [];
    cleanup.push(
      MakaioBus.on(ClientSubjects.session.account.observe, (ctx) => {
        observations.push(ClientSessionAccountObserveSchema.request.parse(ctx.payload));
        ctx.setResult({
          handled: false,
          sessionId: null,
          clientAccountId: null,
          changed: false,
        });
      }),
    );

    await fireTurnComplete(connector, { outcome: 'completed', result: { message: 'first' } }, 'message-1');
    await vi.waitFor(() => expect(observations).toHaveLength(1));

    await fireTurnComplete(connector, { outcome: 'completed', result: { message: 'second' } }, 'message-2');
    await vi.waitFor(() => expect(observations).toHaveLength(2));

    expect(accountInfo).toHaveBeenCalledTimes(2);
    expect(observations[0]?.payload).toEqual(observations[1]?.payload);
  });

  it('does not emit a duplicate observation while the same snapshot is already in flight', async () => {
    const connector = await makeConnector();
    sessionHarness.setAdapterSessionId('adapter-session-1');

    const accountInfo = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      accountUuid: '77777777-7777-4777-8777-777777777777',
      orgUuid: '88888888-8888-4888-8888-888888888888',
      email: 'USER@example.com',
      organization: 'Org One',
      subscriptionType: 'Claude Team',
      apiProvider: 'firstParty',
    });
    sessionHarness.setQueryInstance({ accountInfo });

    const observations: ClientSessionAccountObserveRequest[] = [];
    let resolveObservation: (() => void) | undefined;
    const observationBlocked = new Promise<void>((resolve) => {
      resolveObservation = resolve;
    });
    cleanup.push(
      MakaioBus.on(ClientSubjects.session.account.observe, async (ctx) => {
        observations.push(ClientSessionAccountObserveSchema.request.parse(ctx.payload));
        await observationBlocked;
        ctx.setResult({
          handled: true,
          sessionId: 'session-1',
          clientAccountId: 'client-account-1',
          changed: true,
        });
      }),
    );

    const firstTurn = fireTurnComplete(connector, { outcome: 'completed', result: { message: 'first' } }, 'message-1');
    await vi.waitFor(() => expect(observations).toHaveLength(1));

    const secondTurn = fireTurnComplete(
      connector,
      { outcome: 'completed', result: { message: 'second' } },
      'message-2',
    );
    await Promise.resolve();

    expect(observations).toHaveLength(1);
    expect(accountInfo).toHaveBeenCalledTimes(2);

    resolveObservation?.();
    await firstTurn;
    await secondTurn;

    expect(observations).toHaveLength(1);
  });

  it('coalesces overlapping declined observations into one retry after the in-flight request settles', async () => {
    const connector = await makeConnector();
    sessionHarness.setAdapterSessionId('adapter-session-1');

    const accountInfo = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({
      accountUuid: '99999999-9999-4999-8999-999999999999',
      orgUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'USER@example.com',
      organization: 'Org Retry',
      subscriptionType: 'Claude Team',
      apiProvider: 'firstParty',
    });
    sessionHarness.setQueryInstance({ accountInfo });

    const observations: ClientSessionAccountObserveRequest[] = [];
    let resolveFirstObservation: (() => void) | undefined;
    const firstObservationBlocked = new Promise<void>((resolve) => {
      resolveFirstObservation = resolve;
    });
    let observationAttempts = 0;
    cleanup.push(
      MakaioBus.on(ClientSubjects.session.account.observe, async (ctx) => {
        observationAttempts += 1;
        observations.push(ClientSessionAccountObserveSchema.request.parse(ctx.payload));
        if (observationAttempts === 1) {
          await firstObservationBlocked;
        }
        ctx.setResult({
          handled: false,
          sessionId: null,
          clientAccountId: null,
          changed: false,
        });
      }),
    );

    const firstTurn = fireTurnComplete(connector, { outcome: 'completed', result: { message: 'first' } }, 'message-1');
    await vi.waitFor(() => expect(observations).toHaveLength(1));

    const secondTurn = fireTurnComplete(
      connector,
      { outcome: 'completed', result: { message: 'second' } },
      'message-2',
    );
    const thirdTurn = fireTurnComplete(connector, { outcome: 'completed', result: { message: 'third' } }, 'message-3');
    await Promise.resolve();

    expect(observations).toHaveLength(1);

    resolveFirstObservation?.();
    await firstTurn;
    await secondTurn;
    await thirdTurn;

    await vi.waitFor(() => expect(observations).toHaveLength(2));
    expect(accountInfo).toHaveBeenCalledTimes(3);
    expect(observations[0]?.payload).toEqual(observations[1]?.payload);
  });
});

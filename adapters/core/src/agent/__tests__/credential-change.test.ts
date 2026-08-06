import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, CredentialSubjects, type ResolvedProviderContext } from '@makaio/contracts';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import { createMockScopedBus } from '@makaio/test-utils';

import type { AIAgentConfig } from '../types.js';
import { AgentTeardownArbiter } from '../agent-teardown-arbiter.js';
import {
  asAgentConnector,
  createAgentTestLifecycle,
  createTestableAgent,
  registerSuccessfulRuntimeMutationPersistence,
  TestableAgent,
} from './helpers/mock-agent.js';

type CredentialChangeRequest = (typeof AgentSubjects.credential.change)['$meta']['payload']['request'];
type CredentialChangeResponse = (typeof AgentSubjects.credential.change)['$meta']['payload']['response'];
type ActivationPrepareRequest = (typeof CredentialSubjects.activation.prepare)['$meta']['payload']['request'];

const TEST_AGENT_ID = 'test-agent-credential';

/**
 * Build a complete explicit-auth provider context with one opaque stored ref.
 * @param providerConfigId - Provider config identity for the test selection
 * @param credentialSlot - Credential-store slot selected by the explicit method
 * @returns Resolved explicit-auth context
 */
function makeExplicitContext(providerConfigId = 'test-config', credentialSlot = 'apiKey'): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId,
    definitionId: 'test-def',
    endpointOverrides: { anthropic: 'https://api.test.example.com' },
    auth: {
      mode: 'explicit',
      method: { owner: 'provider', providerDefinitionId: 'test-def', methodId: 'api-key' },
      definition: {
        id: 'api-key',
        mode: 'explicit',
        label: 'API key',
        fields: [
          {
            id: 'apiKey',
            label: 'API key',
            required: true,
            secret: true,
            sourceHints: [{ kind: 'environment', variable: 'TEST_API_KEY' }],
          },
        ],
      },
      credentialRefs: { apiKey: buildStoredCredentialRef(providerConfigId, credentialSlot) },
    },
  };
}

/**
 * Build a managed native-account provider context used to exercise activation.
 * @param accountId - Native account selected by the provider config
 * @returns Resolved inferred-auth context
 */
function makeInferredContext(accountId: string): ResolvedProviderContext {
  return {
    state: 'resolved',
    providerConfigId: 'test-config',
    definitionId: 'test-def',
    auth: {
      mode: 'inferred',
      method: { owner: 'client', clientId: 'test-client', methodId: 'native' },
      definition: { id: 'native', mode: 'inferred', label: 'Native client' },
      account: { managerId: 'account-manager', accountId },
    },
  };
}

/** Small deferred helper for coordinating overlapping async flows. */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve: () => resolve?.() };
}

interface ActivationTransactionFixture {
  /** Prepare hook; return a failure code to reject preparation. */
  prepare?: (
    providerContext: ActivationPrepareRequest['providerContext'],
  ) => void | Promise<void> | 'account-not-found' | 'activation-failed';
  /** Commit hook for a successfully prepared transaction. */
  commit?: () => void | Promise<void> | 'commit-failed' | 'commit-rollback-failed';
  /** Rollback hook for a prepared transaction that cannot commit. */
  rollback?: () => void | Promise<void> | 'rollback-failed';
}

/**
 * Register strict local activation-transaction handlers for one test.
 * @param fixture - Transaction callbacks and injected failure controls
 * @param cleanups - Bus-handler cleanup collection for the test lifecycle
 */
function registerActivationTransaction(fixture: ActivationTransactionFixture, cleanups: Array<() => void>): void {
  cleanups.push(
    MakaioBus.on(CredentialSubjects.activation.prepare, async (activateCtx) => {
      const failure = await fixture.prepare?.(activateCtx.payload.providerContext);
      if (failure === 'account-not-found' || failure === 'activation-failed') {
        activateCtx.setResult({ success: false, code: failure });
        return;
      }
      activateCtx.setResult({ success: true, transactionId: crypto.randomUUID() });
    }),
    MakaioBus.on(CredentialSubjects.activation.commit, async (activateCtx) => {
      const failure = await fixture.commit?.();
      if (failure === 'commit-failed' || failure === 'commit-rollback-failed') {
        activateCtx.setResult({ success: false, code: failure });
        return;
      }
      activateCtx.setResult({ success: true });
    }),
    MakaioBus.on(CredentialSubjects.activation.rollback, async (activateCtx) => {
      const failure = await fixture.rollback?.();
      if (failure === 'rollback-failed') {
        activateCtx.setResult({ success: false, code: failure });
        return;
      }
      activateCtx.setResult({ success: true });
    }),
  );
}

/**
 * Send one normalized credential-change request for the standard test agent.
 * @param overrides - Request fields that differ from the default fixture
 * @returns Credential-change response from the agent
 */
async function sendCredentialChange(
  overrides: Partial<Omit<CredentialChangeRequest, 'agentId'>> = {},
): Promise<CredentialChangeResponse> {
  return MakaioBus.request(AgentSubjects.credential.change, {
    agentId: TEST_AGENT_ID,
    adapterId: 'test-adapter',
    adapterName: 'test',
    adapterSessionId: 'test-session-id',
    changeSequence: 1,
    providerContext: makeExplicitContext(),
    ...overrides,
  });
}

describe('AIAgent credential.change handler', () => {
  const ctx = createAgentTestLifecycle();
  let persistenceCleanup: () => void;

  beforeEach(() => {
    ctx.reset();
    persistenceCleanup = registerSuccessfulRuntimeMutationPersistence();
  });
  afterEach(async () => {
    persistenceCleanup();
    await ctx.teardown();
  });

  it('swaps the connector using the normalized provider context directly', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();

    await expect(sendCredentialChange()).resolves.toEqual({ success: true, swapped: true });
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('rejects with committed-state semantics when credential persistence is unavailable', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
    });
    await ctx.agent.init();
    persistenceCleanup();
    persistenceCleanup = () => undefined;

    await expect(sendCredentialChange()).rejects.toThrow(
      'Runtime mutation committed, but durable agent-state persistence failed.',
    );
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(ctx.agent.testPrimaryConnector()).toBe(ctx.createdConnectors[1]);
  });

  it('rejects a change targeting a different provider config', async () => {
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      mockConnectorFactory: ctx.mockFactory,
      providerContext: makeExplicitContext('other-config'),
    });
    await ctx.agent.init();

    await expect(sendCredentialChange()).resolves.toEqual({ success: false, reason: 'provider_mismatch' });
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('rejects credential changes while a turn is active', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    ctx.agent.currentConnector.setProcessingState('processing_started');

    await expect(sendCredentialChange()).resolves.toEqual({ success: false, reason: 'turn_active' });
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('ignores a stale sequence after a newer normalized selection was applied', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();

    await expect(
      sendCredentialChange({ changeSequence: 2, providerContext: makeExplicitContext('test-config', 'newer') }),
    ).resolves.toEqual({ success: true, swapped: true });
    await expect(
      sendCredentialChange({ changeSequence: 1, providerContext: makeExplicitContext('test-config', 'stale') }),
    ).resolves.toEqual({ success: false, reason: 'stale_change' });
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('rejects an older in-flight account selection once a newer sequence supersedes it', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    const firstActivationStarted = createDeferred();
    const releaseFirstActivation = createDeferred();
    const rolledBackAccounts: string[] = [];
    registerActivationTransaction(
      {
        prepare: async (providerContext) => {
          const { auth } = providerContext;
          if (auth.mode === 'inferred' && auth.account?.accountId === 'stale-account') {
            firstActivationStarted.resolve();
            await releaseFirstActivation.promise;
          }
        },
        rollback: () => {
          rolledBackAccounts.push('stale-account');
        },
      },
      ctx.cleanupFns,
    );

    const stale = sendCredentialChange({
      changeSequence: 1,
      providerContext: makeInferredContext('stale-account'),
    });
    await firstActivationStarted.promise;
    const newer = sendCredentialChange({
      changeSequence: 2,
      providerContext: makeInferredContext('newer-account'),
    });
    releaseFirstActivation.resolve();

    await expect(stale).resolves.toEqual({ success: false, reason: 'stale_change' });
    await expect(newer).resolves.toEqual({ success: true, swapped: true });
    expect(rolledBackAccounts).toEqual(['stale-account']);
    expect(ctx.createdConnectors).toHaveLength(2);
  });

  it('prepares account state before replacement creation and commits only after initialization', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    const order: string[] = [];
    const providerContext = makeInferredContext('account-1');
    registerActivationTransaction(
      {
        prepare: (preparedContext) => {
          order.push('prepare');
          expect(preparedContext).toEqual(providerContext);
        },
        commit: () => {
          order.push('commit');
          expect(ctx.agent?.testPrimaryConnector()).toBe(ctx.createdConnectors[0]);
        },
      },
      ctx.cleanupFns,
    );
    const originalFactory = ctx.mockFactory.getMockImplementation();
    if (!originalFactory) throw new Error('Expected mock connector factory implementation.');
    ctx.mockFactory.mockImplementation((config) => {
      order.push('swap');
      const replacement = originalFactory(config);
      replacement.initialize = vi.fn(async () => {
        order.push('initialize');
      });
      return replacement;
    });

    await expect(sendCredentialChange({ providerContext })).resolves.toEqual({ success: true, swapped: true });
    expect(order).toEqual(['prepare', 'swap', 'initialize', 'commit']);
    expect(ctx.agent.testPrimaryConnector()).toBe(ctx.createdConnectors[1]);
  });

  it('returns a typed credential-free failure when account activation fails', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    registerActivationTransaction({ prepare: () => 'account-not-found' }, ctx.cleanupFns);

    await expect(
      sendCredentialChange({ providerContext: makeInferredContext('secret-account-coordinate') }),
    ).resolves.toEqual({ success: false, reason: 'credential_activation_failed:account-not-found' });
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('rolls back when connector idleness changes after account preparation', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    const agent = ctx.agent;
    const rollback = vi.fn();
    registerActivationTransaction(
      {
        prepare: () => {
          agent.currentConnector.setProcessingState('processing_started');
        },
        rollback,
      },
      ctx.cleanupFns,
    );

    await expect(sendCredentialChange({ providerContext: makeInferredContext('account-1') })).resolves.toEqual({
      success: false,
      reason: 'turn_active',
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('holds a turn arriving during account preparation until the transaction commits', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    const prepareStarted = createDeferred();
    const releasePrepare = createDeferred();
    registerActivationTransaction(
      {
        prepare: async () => {
          prepareStarted.resolve();
          await releasePrepare.promise;
        },
      },
      ctx.cleanupFns,
    );

    const change = sendCredentialChange({ providerContext: makeInferredContext('account-1') });
    await prepareStarted.promise;
    const turn = MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      message: 'after credential transaction',
    });
    await Promise.resolve();
    expect(ctx.createdConnectors[0]?.sentMessages).toHaveLength(0);

    releasePrepare.resolve();
    await expect(change).resolves.toEqual({ success: true, swapped: true });
    await expect(turn).resolves.toEqual(expect.objectContaining({ messageId: expect.any(String) }));
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(ctx.createdConnectors[1]?.sentMessages).toHaveLength(1);
  });

  it('holds a turn while the replacement initializes and dispatches it on the committed primary', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    registerActivationTransaction({}, ctx.cleanupFns);
    const replacementInitializeStarted = createDeferred();
    const releaseReplacementInitialize = createDeferred();
    const originalFactory = ctx.mockFactory.getMockImplementation();
    if (!originalFactory) throw new Error('Expected mock connector factory implementation.');
    ctx.mockFactory.mockImplementation((config) => {
      const replacement = originalFactory(config);
      replacement.initialize = vi.fn(async () => {
        replacementInitializeStarted.resolve();
        await releaseReplacementInitialize.promise;
      });
      return replacement;
    });

    const change = sendCredentialChange({ providerContext: makeInferredContext('account-1') });
    await replacementInitializeStarted.promise;
    const turn = MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      message: 'after replacement commit',
    });
    await Promise.resolve();
    expect(ctx.createdConnectors.every((connector) => connector.sentMessages.length === 0)).toBe(true);

    releaseReplacementInitialize.resolve();
    await expect(change).resolves.toEqual({ success: true, swapped: true });
    await expect(turn).resolves.toEqual(expect.objectContaining({ messageId: expect.any(String) }));
    expect(ctx.createdConnectors[1]?.sentMessages).toHaveLength(1);
  });

  it('rolls back an initialized replacement when the original connector becomes active before commit', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    const originalConnector = ctx.createdConnectors[0]!;
    const rollback = vi.fn();
    registerActivationTransaction({ rollback }, ctx.cleanupFns);
    const originalFactory = ctx.mockFactory.getMockImplementation();
    if (!originalFactory) throw new Error('Expected mock connector factory implementation.');
    ctx.mockFactory.mockImplementation((config) => {
      const replacement = originalFactory(config);
      replacement.initialize = vi.fn(async () => {
        originalConnector.setProcessingState('processing_started');
      });
      return replacement;
    });

    await expect(sendCredentialChange({ providerContext: makeInferredContext('account-1') })).resolves.toEqual({
      success: false,
      reason: 'turn_active',
    });
    expect(ctx.agent.testPrimaryConnector()).toBe(originalConnector);
    expect(ctx.createdConnectors[1]?.closeCalled).toBe(true);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back a ready stale replacement before applying the newer sequence', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    const rollback = vi.fn();
    registerActivationTransaction({ rollback }, ctx.cleanupFns);
    const replacementInitializeStarted = createDeferred();
    const releaseReplacementInitialize = createDeferred();
    const originalFactory = ctx.mockFactory.getMockImplementation();
    if (!originalFactory) throw new Error('Expected mock connector factory implementation.');
    let replacementCount = 0;
    ctx.mockFactory.mockImplementation((config) => {
      const replacement = originalFactory(config);
      replacementCount += 1;
      if (replacementCount === 1) {
        replacement.initialize = vi.fn(async () => {
          replacementInitializeStarted.resolve();
          await releaseReplacementInitialize.promise;
        });
      }
      return replacement;
    });

    const stale = sendCredentialChange({
      changeSequence: 1,
      providerContext: makeInferredContext('stale-account'),
    });
    await replacementInitializeStarted.promise;
    const newer = sendCredentialChange({
      changeSequence: 2,
      providerContext: makeInferredContext('newer-account'),
    });
    releaseReplacementInitialize.resolve();

    await expect(stale).resolves.toEqual({ success: false, reason: 'stale_change' });
    await expect(newer).resolves.toEqual({ success: true, swapped: true });
    expect(ctx.createdConnectors).toHaveLength(3);
    expect(ctx.createdConnectors[1]?.closeCalled).toBe(true);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('surfaces a sanitized AggregateError when swap failure and account rollback both fail', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    registerActivationTransaction({ rollback: () => 'rollback-failed' }, ctx.cleanupFns);
    ctx.mockFactory.mockImplementation(() => {
      throw new Error('connector failure containing secret-value');
    });

    const error = await sendCredentialChange({ providerContext: makeInferredContext('account-1') }).catch(
      (cause: unknown) => cause,
    );
    const cause = (error as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(String(error)).not.toContain('secret-value');
    expect(String(cause)).not.toContain('secret-value');
    expect(ctx.createdConnectors).toHaveLength(1);
  });

  it('persists the full normalized context for subsequent connector swaps', async () => {
    const { bus: mockBus } = createMockScopedBus();
    const capturedContexts: Array<unknown> = [];
    const config: AIAgentConfig = {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      capabilities: [],
      nativeTools: [],
      adapterBus: mockBus,
      teardownArbiter: new AgentTeardownArbiter(),
      globalBus: MakaioBus,
      model: 'test-model-1',
      cwd: '/test/cwd',
      configFactory: async (input) => {
        capturedContexts.push(input.providerContext);
        return {
          bus: mockBus,
          agentId: TEST_AGENT_ID,
          adapterId: 'test-adapter',
          adapterName: 'test',
          model: input.model ?? 'test-model-1',
          cwd: input.cwd ?? '/test/cwd',
        };
      },
      connectorFactory: async (factoryConfig) =>
        asAgentConnector(ctx.mockFactory({ model: factoryConfig.model, cwd: factoryConfig.cwd })),
    };
    ctx.agent = new TestableAgent(config, ctx.mockFactory);
    await ctx.agent.init();
    const rotatedContext = makeExplicitContext('test-config', 'rotated');

    await sendCredentialChange({ providerContext: rotatedContext });
    await ctx.agent.swapConnector();

    expect(capturedContexts).toHaveLength(3);
    expect(capturedContexts[1]).toEqual(rotatedContext);
    expect(capturedContexts[2]).toEqual(rotatedContext);
  });

  it('does not expose connector failure messages in the response', async () => {
    ctx.agent = createTestableAgent({ agentId: TEST_AGENT_ID, mockConnectorFactory: ctx.mockFactory });
    await ctx.agent.init();
    ctx.mockFactory.mockImplementation(() => {
      throw new Error('connector error containing secret-value');
    });

    await expect(sendCredentialChange()).resolves.toEqual({ success: false, reason: 'credential_swap_failed' });
    expect(ctx.createdConnectors).toHaveLength(1);
  });
});

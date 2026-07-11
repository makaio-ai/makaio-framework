import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import {
  CredentialSubjects,
  SessionSubjects,
  SubagentSubjects,
  defineAdapterProviderAuth,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import {
  AdapterSubsystemSubjects,
  type AdapterRuntimeSnapshotResolution,
} from '@makaio/services-core/adapter-subsystem';
import { RuntimeProviderContextResolutionError } from '../../provider-context/index.js';
import { SubagentFailureFinalizationError, SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

describe('SubagentService provider context', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;
  let closedSessionIds: string[];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    closedSessionIds = [];
    mocks = setupSubagentServiceMocks(MakaioBus);
    MakaioBus.on(SessionSubjects.create, (ctx) => ctx.setResult({ sessionId: 'child-provider-context' }));
    MakaioBus.on(SessionSubjects.close, (ctx) => {
      closedSessionIds.push(ctx.payload.sessionId);
      ctx.setResult({ success: true });
    });
    service = new SubagentService(MakaioBus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    MakaioBus.__resetHandlers?.();
  });

  it('reuses an already resolved provider context without taking another runtime snapshot', async () => {
    const providerContext = {
      state: 'resolved',
      providerConfigId: 'provider-config-carried',
      definitionId: 'provider-def-1',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'provider-def-1', methodId: 'none' },
        definition: { id: 'none', mode: 'none', label: 'No authentication' },
      },
    } satisfies ResolvedProviderContext;
    let runtimeReads = 0;
    const adapterStartCalls: unknown[] = [];

    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      runtimeReads += 1;
      ctx.setResult({ status: 'error', code: 'provider-config-not-found' });
    });
    mocks.setStartAgentHandler((ctx) => {
      adapterStartCalls.push(ctx.payload);
      ctx.setResult({
        success: true,
        agentId: 'agent-carried',
        adapterId: String(ctx.payload.adapterId),
        adapterSessionId: 'adapter-session-carried',
        sessionId: 'child-provider-context',
      });
    });

    const result = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-carried',
      parentSessionId: 'parent-1',
      task: 'Use the carried context',
      config: {
        task: 'Use the carried context',
        adapterName: 'claude-code',
        providerConfigId: providerContext.providerConfigId,
        providerContext,
        contextMode: 'fork',
      },
      depth: 1,
    });

    expect(result).toEqual({ success: true });
    expect(runtimeReads).toBe(0);
    expect(adapterStartCalls).toEqual([expect.objectContaining({ providerContext })]);
    expect(closedSessionIds).toHaveLength(0);
  });

  it('activates the exact inferred context before starting the selected adapter', async () => {
    const providerContext = {
      state: 'resolved',
      providerConfigId: 'provider-config-1',
      definitionId: 'provider-def-1',
      auth: {
        mode: 'inferred',
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        definition: { id: 'native', mode: 'inferred', label: 'Native account' },
        account: { managerId: 'account-manager', accountId: 'account-1' },
      },
    } satisfies ResolvedProviderContext;
    const providerConfig = {
      id: providerContext.providerConfigId,
      definitionId: providerContext.definitionId,
      name: 'Provider',
      modelFilterMode: 'show-all' as const,
      isDefault: false,
      enabled: true,
      auth: {
        mode: providerContext.auth.mode,
        method: providerContext.auth.method,
        account: providerContext.auth.account,
        hasCredentials: false as const,
      },
    };
    const providerDefinition = {
      id: providerContext.definitionId,
      packageName: '@makaio/provider-test',
      name: 'Provider',
      endpoints: { anthropic: 'https://api.example.com' },
      availableModels: [],
      authMethods: [],
      defaultModelFilterMode: 'show-all' as const,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const order: string[] = [];
    let credentialActivated = false;

    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      expect(ctx.payload).toEqual({
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
      });
      const resolution: AdapterRuntimeSnapshotResolution = {
        status: 'resolved',
        runtime: {
          snapshot: { config: providerConfig, context: providerContext, definition: providerDefinition },
          adapterName: ctx.payload.adapterName,
          adapterClientId: 'claude-code',
          adapterProviderAuth: defineAdapterProviderAuth({
            bindings: [
              {
                method: providerContext.auth.method,
                deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
              },
            ],
            scrubEnvVars: ['API_KEY'],
          }),
          compatibleProviderAuths: [],
          runtimePackages: {
            adapter: { packageName: '@makaio/adapter-claude-code' },
            provider: { packageName: '@makaio/provider-test', definitionId: providerContext.definitionId },
            client: { packageName: '@makaio/client-claude-code', clientId: 'claude-code' },
          },
        },
      };
      ctx.setResult(resolution);
    });
    MakaioBus.on(CredentialSubjects.activate, (ctx) => {
      credentialActivated = true;
      ctx.setResult({ success: true });
    });
    mocks.setStartAgentHandler((ctx) => {
      order.push('start');
      ctx.setResult({
        success: true,
        agentId: 'agent-native',
        adapterId: String(ctx.payload.adapterId),
        adapterSessionId: 'adapter-session-native',
        sessionId: 'child-provider-context',
      });
    });

    const result = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-native',
      parentSessionId: 'parent-1',
      task: 'Use native account',
      config: {
        task: 'Use native account',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
        contextMode: 'fork',
      },
      depth: 1,
    });

    expect(result).toEqual({ success: true });
    expect(order).toEqual(['start']);
    expect(credentialActivated).toBe(false);
  });

  it('rejects an unresolved carried context when a provider config is selected', async () => {
    let runtimeReads = 0;
    let startCalled = false;
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      runtimeReads += 1;
      ctx.setResult({ status: 'error', code: 'provider-config-not-found' });
    });
    mocks.setStartAgentHandler((ctx) => {
      startCalled = true;
      ctx.setResult({ success: false, message: 'must not start' });
    });

    const result = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-unresolved',
      parentSessionId: 'parent-1',
      task: 'Reject unresolved context',
      config: {
        task: 'Reject unresolved context',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
        providerContext: { state: 'unresolved' },
        contextMode: 'fork',
      },
      depth: 1,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('provider-context-unresolved') });
    expect(runtimeReads).toBe(0);
    expect(startCalled).toBe(false);
    expect(closedSessionIds).toEqual(['child-provider-context']);
  });

  it('rejects conflicting provider config and resolved-context identities without re-resolution', async () => {
    const providerContext = {
      state: 'resolved',
      providerConfigId: 'provider-config-carried',
      definitionId: 'provider-def-1',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'provider-def-1', methodId: 'none' },
        definition: { id: 'none', mode: 'none', label: 'No authentication' },
      },
    } satisfies ResolvedProviderContext;
    let runtimeReads = 0;
    let startCalled = false;
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      runtimeReads += 1;
      ctx.setResult({ status: 'error', code: 'provider-config-not-found' });
    });
    mocks.setStartAgentHandler((ctx) => {
      startCalled = true;
      ctx.setResult({ success: false, message: 'must not start' });
    });

    const result = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-conflict',
      parentSessionId: 'parent-1',
      task: 'Reject conflicting identities',
      config: {
        task: 'Reject conflicting identities',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-other',
        providerContext,
        contextMode: 'fork',
      },
      depth: 1,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('does not match') });
    expect(runtimeReads).toBe(0);
    expect(startCalled).toBe(false);
    expect(closedSessionIds).toEqual(['child-provider-context']);
  });

  it.each([
    'provider-config-not-found',
    'provider-config-disabled',
  ] as const)('stops before adapter startup when atomic provider resolution returns %s', async (code) => {
    let startCalled = false;
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      expect(ctx.payload).toEqual({
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
      });
      ctx.setResult({ status: 'error', code });
    });
    mocks.setStartAgentHandler((ctx) => {
      startCalled = true;
      ctx.setResult({ success: false, message: 'must not start' });
    });

    const result = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: `sub-${code}`,
      parentSessionId: 'parent-1',
      task: 'Reject unavailable provider config',
      config: {
        task: 'Reject unavailable provider config',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
        contextMode: 'fork',
      },
      depth: 1,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining(code) });
    expect(startCalled).toBe(false);
    expect(closedSessionIds).toEqual(['child-provider-context']);
  });

  it('publishes the primary failure and reports a sanitized aggregate when child close also fails', async () => {
    const closeFailureDetail = 'private close backend detail';
    let closeAttempts = 0;
    const publishedFailures: unknown[] = [];
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      ctx.setResult({ status: 'error', code: 'provider-config-not-found' });
    });
    MakaioBus.on(
      SessionSubjects.close,
      () => {
        closeAttempts += 1;
        throw new Error(closeFailureDetail);
      },
      { priority: 100 },
    );
    MakaioBus.on(SubagentSubjects.executionFailed, (ctx) => {
      publishedFailures.push(ctx.payload);
    });

    const error = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-close-failure',
      parentSessionId: 'parent-1',
      task: 'Exercise dual failure',
      config: {
        task: 'Exercise dual failure',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
        contextMode: 'fork',
      },
      depth: 1,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestError);
    const aggregate = (error as RequestError).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors[0]).toBeInstanceOf(RuntimeProviderContextResolutionError);
    expect((aggregate as AggregateError).errors[1]).toMatchObject<Partial<SubagentFailureFinalizationError>>({
      code: 'child-session-close-failed',
    });
    expect((aggregate as AggregateError).errors.map(String).join('\n')).not.toContain(closeFailureDetail);
    expect(closeAttempts).toBe(1);
    expect(publishedFailures).toEqual([
      expect.objectContaining({ phase: 'adapter_start', error: expect.stringContaining('provider-config-not-found') }),
    ]);
  });

  it('closes the child and reports a sanitized aggregate when failure publication also fails', async () => {
    const publicationFailureDetail = 'private event backend detail';
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
      ctx.setResult({ status: 'error', code: 'provider-config-disabled' });
    });
    MakaioBus.on(
      SubagentSubjects.executionFailed,
      () => {
        throw new Error(publicationFailureDetail);
      },
      { priority: 100 },
    );

    const error = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'sub-publication-failure',
      parentSessionId: 'parent-1',
      task: 'Exercise publication failure',
      config: {
        task: 'Exercise publication failure',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-1',
        contextMode: 'fork',
      },
      depth: 1,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestError);
    const aggregate = (error as RequestError).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors[0]).toBeInstanceOf(RuntimeProviderContextResolutionError);
    expect((aggregate as AggregateError).errors[1]).toMatchObject<Partial<SubagentFailureFinalizationError>>({
      code: 'failure-publication-failed',
    });
    expect((aggregate as AggregateError).errors.map(String).join('\n')).not.toContain(publicationFailureDetail);
    expect(closedSessionIds).toEqual(['child-provider-context']);
  });
});

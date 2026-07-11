import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  defineAdapterProviderAuth,
  type MakaioSessionAgent,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import type { ExtractSubjectPayload } from '@makaio/core';
import { ensureAgentModel } from '../session-orchestrator-helpers.js';
import { createMockAgent, resetBusHandlers, type UnsubscribeFunction } from '../testing/orchestrator-shared.js';

type ModelChangePayload = ExtractSubjectPayload<typeof AgentSubjects.model.change>;

/** Shared normalized provider context returned by the atomic runtime fixture. */
const EXPECTED_PROVIDER_CONTEXT_BASE = {
  state: 'resolved' as const,
  definitionId: 'anthropic',
  auth: {
    mode: 'none' as const,
    method: { owner: 'provider' as const, providerDefinitionId: 'anthropic', methodId: 'none' },
    definition: { id: 'none', mode: 'none' as const, label: 'No authentication' },
  },
} satisfies Partial<ResolvedProviderContext>;

describe('ensureAgentModel', () => {
  let unsubscribers: UnsubscribeFunction[];

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    unsubscribers.push(
      MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
        const providerConfigId = ctx.payload.providerConfigId;
        const method = { owner: 'provider' as const, providerDefinitionId: 'anthropic', methodId: 'none' };
        const methodDefinition = { id: 'none', mode: 'none' as const, label: 'No authentication' };
        ctx.setResult({
          status: 'resolved',
          runtime: {
            snapshot: {
              config: {
                id: providerConfigId,
                definitionId: 'anthropic',
                name: 'Provider Config',
                auth: { mode: 'none', method, hasCredentials: false },
                isDefault: true,
                enabled: true,
                modelFilterMode: 'show-all',
              },
              context: { ...EXPECTED_PROVIDER_CONTEXT_BASE, providerConfigId },
              definition: {
                id: 'anthropic',
                packageName: '@makaio/provider-anthropic',
                name: 'Anthropic',
                availableModels: [],
                authMethods: [methodDefinition],
                defaultModelFilterMode: 'show-all',
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
              },
            },
            adapterName: ctx.payload.adapterName,
            adapterProviderAuth: defineAdapterProviderAuth({
              bindings: [{ method, deliveries: [{ kind: 'none' }] }],
              scrubEnvVars: [],
            }),
            compatibleProviderAuths: [],
            runtimePackages: {
              adapter: { packageName: '@makaio/adapter-test' },
              provider: { packageName: '@makaio/provider-anthropic', definitionId: 'anthropic' },
            },
          },
        });
      }),
    );
  });

  afterEach(() => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  });

  it('returns {changed:false} when model already matches', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    const requestSpy = vi.spyOn(MakaioBus, 'request');

    const result = await ensureAgentModel(MakaioBus, agent, 'gpt-4o');

    expect(result).toEqual({ changed: false });
    expect(requestSpy).not.toHaveBeenCalled();
    requestSpy.mockRestore();
  });

  it('returns {changed:true, swapped:false} for native in-place model change', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        ctx.setResult({ success: true, swapped: false });
      }),
    );

    const result = await ensureAgentModel(MakaioBus, agent, 'gpt-4o-mini');

    expect(result).toEqual({ changed: true, swapped: false });
    expect(agent.model).toBe('gpt-4o-mini');
  });

  it('returns {changed:true, swapped:true} when connector was swapped', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        ctx.setResult({ success: true, swapped: true });
      }),
    );

    const result = await ensureAgentModel(MakaioBus, agent, 'claude-sonnet-4-20250514');

    expect(result).toEqual({ changed: true, swapped: true });
    expect(agent.model).toBe('claude-sonnet-4-20250514');
  });

  it('defaults swapped to false when response omits swapped field (in-place change)', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );

    const result = await ensureAgentModel(MakaioBus, agent, 'gpt-4o-mini');

    expect(result).toEqual({ changed: true, swapped: false });
  });

  it('throws when model change fails', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        ctx.setResult({ success: false, reason: 'turn_active' });
      }),
    );

    await expect(ensureAgentModel(MakaioBus, agent, 'gpt-4o-mini')).rejects.toThrow(
      'Failed to change model for agent agent-1: turn_active',
    );
  });

  it('resolves providerContext and forwards skipWarning options to bus request', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    let capturedPayload: ModelChangePayload | undefined;

    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        capturedPayload = ctx.payload;
        ctx.setResult({ success: true, swapped: true });
      }),
    );

    await ensureAgentModel(MakaioBus, agent, 'gpt-4o-mini', {
      providerConfigId: 'provider-xyz',
      skipWarning: true,
    });

    expect(capturedPayload).toMatchObject({
      newModel: 'gpt-4o-mini',
      providerContext: { ...EXPECTED_PROVIDER_CONTEXT_BASE, providerConfigId: 'provider-xyz' },
      skipWarning: true,
    });
  });

  it('does not include providerContext/skipWarning when options are absent', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    let capturedPayload: ModelChangePayload | undefined;

    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        capturedPayload = ctx.payload;
        ctx.setResult({ success: true, swapped: false });
      }),
    );

    await ensureAgentModel(MakaioBus, agent, 'gpt-4o-mini');

    expect(capturedPayload).not.toHaveProperty('providerContext');
    expect(capturedPayload).not.toHaveProperty('skipWarning');
  });

  it('returns {changed:true, swapped:false} for reasoning-effort-only change', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    let capturedPayload: ModelChangePayload | undefined;

    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        capturedPayload = ctx.payload;
        ctx.setResult({ success: true, swapped: false });
      }),
    );

    const result = await ensureAgentModel(MakaioBus, agent, undefined, {
      reasoningEffort: 'high',
    });

    // desiredModel is undefined — model must not be included in the payload
    expect(capturedPayload).not.toHaveProperty('newModel');
    expect(capturedPayload).toMatchObject({ reasoningEffort: 'high' });
    expect(result).toEqual({ changed: true, swapped: false });
    // agent.model must remain unchanged when no desiredModel was given
    expect(agent.model).toBe('gpt-4o');
  });

  it('returns {changed:true, swapped:false} for combined model + reasoning change', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    let capturedPayload: ModelChangePayload | undefined;

    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        capturedPayload = ctx.payload;
        ctx.setResult({ success: true, swapped: false });
      }),
    );

    const result = await ensureAgentModel(MakaioBus, agent, 'gpt-4o-mini', {
      reasoningEffort: 'medium',
    });

    expect(capturedPayload).toMatchObject({ newModel: 'gpt-4o-mini', reasoningEffort: 'medium' });
    expect(result).toEqual({ changed: true, swapped: false });
    expect(agent.model).toBe('gpt-4o-mini');
  });

  it('forces swap when providerConfigId is present even if model matches', async () => {
    const agent: MakaioSessionAgent = createMockAgent('agent-1', { model: 'gpt-4o' });
    let capturedPayload: ModelChangePayload | undefined;

    unsubscribers.push(
      MakaioBus.on(AgentSubjects.model.change, (ctx) => {
        capturedPayload = ctx.payload;
        ctx.setResult({ success: true, swapped: true });
      }),
    );

    const result = await ensureAgentModel(MakaioBus, agent, 'gpt-4o', {
      providerConfigId: 'new-provider',
    });

    // Provider-only change still triggers bus request (not short-circuited)
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload).toMatchObject({
      newModel: 'gpt-4o',
      providerContext: { ...EXPECTED_PROVIDER_CONTEXT_BASE, providerConfigId: 'new-provider' },
    });
    expect(result).toEqual({ changed: true, swapped: true });
  });
});

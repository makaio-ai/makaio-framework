import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type MakaioSessionAgent, type ProviderContext } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import type { ExtractSubjectPayload } from '@makaio/core';
import { ensureAgentModel } from '../session-orchestrator-helpers.js';
import { createMockAgent, resetBusHandlers, type UnsubscribeFunction } from '../testing/orchestrator-shared.js';

type ModelChangePayload = ExtractSubjectPayload<typeof AgentSubjects.model.change>;

/** Shared ProviderContext fields returned by buildProviderContext for the test stubs. */
const EXPECTED_PROVIDER_CONTEXT_BASE = {
  definitionId: 'anthropic',
  credentialRefs: {},
} satisfies Partial<ProviderContext>;

describe('ensureAgentModel', () => {
  let unsubscribers: UnsubscribeFunction[];

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    unsubscribers.push(
      MakaioBus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
        ctx.setResult({
          config: {
            id: ctx.payload.id,
            definitionId: EXPECTED_PROVIDER_CONTEXT_BASE.definitionId,
            name: 'Provider Config',
            hasCredentials: false,
            isDefault: true,
            enabled: true,
            isSentinel: false,
            modelFilterMode: 'show-all',
          },
        });
      }),
      MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: ctx.payload.providerConfigId,
            ...EXPECTED_PROVIDER_CONTEXT_BASE,
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
    const requestSpy = spyOn(MakaioBus, 'request');

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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, CredentialSubjects } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { buildAccountManagerCredentialRef } from '@makaio/contracts/config';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AutoActivationConfig } from '../account-manager-types.js';
import { WindowActivator } from '../handlers/window-activator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-abc123';
const WINDOW_ID = '5h';
const DEFINITION_ID = 'anthropic';
const PROVIDER_CONFIG_ID = 'cfg-test-123';
const ADAPTER_NAME = 'claude-code-cli';
const ADAPTER_ID = 'adapter-runtime-uuid-123';
const FAST_MODEL = 'claude-haiku-4-5';
const EXPIRED_AT = 1_000_000;

const ACCOUNT_REF = buildAccountManagerCredentialRef(CLIENT_ID, ACCOUNT_ID);

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal AutoActivationConfig with the given source enabled state.
 * @param enabled - Whether auto-activation is enabled for CLIENT_ID
 * @returns AutoActivationConfig
 */
function makeConfig(enabled: boolean): AutoActivationConfig {
  return {
    sources: new Map([[CLIENT_ID, { enabled }]]),
    systemPrompt: 'Reply concisely.',
    message: 'ok',
  };
}

/**
 * Emits a `usage.windowResetAvailable` event for the test account.
 * @param bus - Bus instance to emit on
 * @param expiredAt - Expired window timestamp for the reset instance
 */
async function emitWindowReset(bus: IMakaioBus, expiredAt: number = EXPIRED_AT): Promise<void> {
  await bus.emit(AccountManagerSubjects.usage.windowResetAvailable, {
    clientId: CLIENT_ID,
    accountId: ACCOUNT_ID,
    windowId: WINDOW_ID,
    expiredAt,
  });
}

/**
 * Registers the full set of bus handlers needed for a successful activation
 * pipeline. Returns cleanup functions.
 * @param bus - Bus instance to register handlers on
 * @param startAgentSuccess - Whether the startAgent call should succeed
 * @param capture - Optional arrays populated with credential/start payloads
 * @returns Cleanup functions array
 */
function registerSuccessHandlers(
  bus: IMakaioBus,
  startAgentSuccess: boolean = true,
  capture: { credentialActivations?: unknown[]; startAgentPayloads?: unknown[]; order?: string[] } = {},
): Array<() => void> {
  return [
    bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      ctx.setResult({
        configs: [
          {
            id: PROVIDER_CONFIG_ID,
            definitionId: DEFINITION_ID,
            name: 'Work Account',
            modelFilterMode: 'show-all' as const,
            isDefault: false,
            enabled: true,
            isSentinel: false,
            hasCredentials: true,
            sourceRef: ACCOUNT_REF,
          },
        ],
      });
    }),
    bus.on(
      AdapterSubsystemSubjects.buildProviderContext,
      (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: PROVIDER_CONFIG_ID,
            definitionId: DEFINITION_ID,
            credentialRefs: {
              token: ACCOUNT_REF,
            },
          },
        });
      },
      { filter: { providerConfigId: PROVIDER_CONFIG_ID } },
    ),
    bus.on(
      AdapterSubsystemSubjects.listBindingsByConfig,
      (ctx) => {
        ctx.setResult({
          bindings: [{ adapterName: ADAPTER_NAME, providerConfigId: PROVIDER_CONFIG_ID, isDefault: true }],
        });
      },
      { filter: { providerConfigId: PROVIDER_CONFIG_ID } },
    ),
    bus.on(
      AdapterRuntimeSubjects.resolveId,
      (ctx) => {
        ctx.setResult({ adapterId: ADAPTER_ID });
      },
      { filter: { adapterName: ADAPTER_NAME } },
    ),
    bus.on(
      ProviderStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          provider: {
            id: DEFINITION_ID,
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModel: 'claude-sonnet-4-6',
            fastModel: FAST_MODEL,
            availableModels: [],
            defaultModelFilterMode: 'show-all' as const,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      },
      { filter: { id: DEFINITION_ID } },
    ),
    bus.on(CredentialSubjects.activate, (ctx) => {
      capture.credentialActivations?.push(ctx.payload);
      capture.order?.push('credential.activate');
      ctx.setResult({});
    }),
    bus.on(AdapterSubjects.startAgent, (ctx) => {
      capture.startAgentPayloads?.push(ctx.payload);
      capture.order?.push('adapter.startAgent');
      if (startAgentSuccess) {
        ctx.setResult({
          success: true,
          agentId: 'agent-ping-1',
          adapterId: ADAPTER_ID,
          adapterSessionId: 'session-ping-1',
          sessionId: 'makaio-session-ping-1',
        });
      } else {
        ctx.setResult({ success: false, message: 'adapter busy' });
      }
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WindowActivator', () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups = [];
    vi.restoreAllMocks();
  });

  it('does nothing when the source is not enabled', async () => {
    const bus = createBusInstance();
    const activator = new WindowActivator(bus, makeConfig(false));
    activator.start();
    cleanups.push(() => activator.stop());

    const startAgentCalls: unknown[] = [];
    cleanups.push(
      bus.on(AdapterSubjects.startAgent, (ctx) => {
        startAgentCalls.push(ctx.payload);
        ctx.setResult({ success: false, message: 'should not be reached' });
      }),
    );

    await emitWindowReset(bus);
    // Give any async work time to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(startAgentCalls).toHaveLength(0);
  });

  it('deduplicates concurrent activations for the same expired window instance', async () => {
    const bus = createBusInstance();

    let startAgentCallCount = 0;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: PROVIDER_CONFIG_ID,
              definitionId: DEFINITION_ID,
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
      bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: PROVIDER_CONFIG_ID,
            definitionId: DEFINITION_ID,
            credentialRefs: { token: ACCOUNT_REF },
          },
        });
      }),
      bus.on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
        ctx.setResult({
          bindings: [{ adapterName: ADAPTER_NAME, providerConfigId: PROVIDER_CONFIG_ID, isDefault: true }],
        });
      }),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: ADAPTER_ID });
      }),
      bus.on(ProviderStorageSubjects.get, (ctx) => {
        ctx.setResult({
          provider: {
            id: DEFINITION_ID,
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            fastModel: FAST_MODEL,
            availableModels: [],
            defaultModelFilterMode: 'show-all' as const,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      }),
      bus.on(AdapterSubjects.startAgent, async (ctx) => {
        startAgentCallCount++;
        releaseFirst();
        // Block until the test releases us so the second event arrives while
        // the first activation is still in-flight.
        await firstGate;
        ctx.setResult({
          success: true,
          agentId: 'agent-dedup-1',
          adapterId: ADAPTER_ID,
          adapterSessionId: 'session-dedup-1',
          sessionId: 'makaio-session-dedup-1',
        });
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    // Emit first event — activation starts, blocks at startAgent.
    void emitWindowReset(bus);
    await firstStarted;

    // Emit second event while first is still in-flight — should be deduped.
    await emitWindowReset(bus);

    // Release the first activation.
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(startAgentCallCount).toBe(1);
  });

  it('allows concurrent activations for different expired window instances', async () => {
    const bus = createBusInstance();

    let startAgentCallCount = 0;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: PROVIDER_CONFIG_ID,
              definitionId: DEFINITION_ID,
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
      bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: PROVIDER_CONFIG_ID,
            definitionId: DEFINITION_ID,
            credentialRefs: { token: ACCOUNT_REF },
          },
        });
      }),
      bus.on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
        ctx.setResult({
          bindings: [{ adapterName: ADAPTER_NAME, providerConfigId: PROVIDER_CONFIG_ID, isDefault: true }],
        });
      }),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: ADAPTER_ID });
      }),
      bus.on(ProviderStorageSubjects.get, (ctx) => {
        ctx.setResult({
          provider: {
            id: DEFINITION_ID,
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            fastModel: FAST_MODEL,
            availableModels: [],
            defaultModelFilterMode: 'show-all' as const,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      }),
      bus.on(AdapterSubjects.startAgent, async (ctx) => {
        startAgentCallCount++;
        if (startAgentCallCount === 1) {
          releaseFirst();
        }
        await gate;
        ctx.setResult({
          success: true,
          agentId: `agent-dedup-${startAgentCallCount}`,
          adapterId: ADAPTER_ID,
          adapterSessionId: `session-dedup-${startAgentCallCount}`,
          sessionId: `makaio-session-dedup-${startAgentCallCount}`,
        });
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    void emitWindowReset(bus, EXPIRED_AT);
    await firstStarted;

    await emitWindowReset(bus, EXPIRED_AT + 60_000);

    await vi.waitFor(() => {
      expect(startAgentCallCount).toBe(2);
    });

    resolveGate();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('returns early without error when no provider config is found', async () => {
    const bus = createBusInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({ configs: [] });
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: unknown[] = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[WindowActivator] No provider config found for account:',
        expect.objectContaining({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }),
      );
    });
    expect(activatedEvents).toHaveLength(0);
  });

  it('returns early without error when buildProviderContext is unavailable', async () => {
    const bus = createBusInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: PROVIDER_CONFIG_ID,
              definitionId: DEFINITION_ID,
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
      // No buildProviderContext handler — requestOptional returns handled=false.
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: unknown[] = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[WindowActivator] Could not build provider context:',
        expect.objectContaining({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }),
      );
    });
    expect(activatedEvents).toHaveLength(0);
  });

  it('returns early without error when adapter subsystem is unavailable for binding lookup', async () => {
    const bus = createBusInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: PROVIDER_CONFIG_ID,
              definitionId: DEFINITION_ID,
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
      bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: PROVIDER_CONFIG_ID,
            definitionId: DEFINITION_ID,
            credentialRefs: { token: ACCOUNT_REF },
          },
        });
      }),
      // No listBindingsByConfig handler — requestOptional returns handled=false.
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: unknown[] = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[WindowActivator] Adapter subsystem unavailable for binding lookup:',
        expect.objectContaining({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }),
      );
    });
    expect(activatedEvents).toHaveLength(0);
  });

  it('emits usage.windowActivated on a successful pipeline run', async () => {
    const bus = createBusInstance();
    const capture: { credentialActivations: unknown[]; startAgentPayloads: unknown[]; order: string[] } = {
      credentialActivations: [],
      startAgentPayloads: [],
      order: [],
    };
    cleanups.push(...registerSuccessHandlers(bus, true, capture));

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: Array<{ clientId: string; accountId: string; windowId: string; model: string }> = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(activatedEvents).toHaveLength(1);
    });
    expect(activatedEvents[0]).toMatchObject({
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      windowId: WINDOW_ID,
      model: FAST_MODEL,
    });
    expect(capture.order).toEqual(['credential.activate', 'adapter.startAgent']);
    expect(capture.credentialActivations).toEqual([
      {
        providerConfigId: PROVIDER_CONFIG_ID,
        definitionId: DEFINITION_ID,
        credentialRefs: { token: ACCOUNT_REF },
      },
    ]);
    expect(capture.startAgentPayloads).toEqual([
      {
        adapterId: ADAPTER_ID,
        role: 'lead',
        ephemeral: true,
        model: FAST_MODEL,
        providerContext: {
          providerConfigId: PROVIDER_CONFIG_ID,
          definitionId: DEFINITION_ID,
          credentialRefs: { token: ACCOUNT_REF },
        },
        initialMessage: 'ok',
        systemPrompt: 'Reply concisely.',
      },
    ]);
  });

  it('activates reset windows already pending when it starts', async () => {
    const bus = createBusInstance();
    const startAgentPayloads: unknown[] = [];
    cleanups.push(
      ...registerSuccessHandlers(bus, true, { startAgentPayloads }),
      bus.on(AccountManagerSubjects.usage.getPendingResets, (ctx) => {
        ctx.setResult({
          pending: [
            {
              clientId: CLIENT_ID,
              accountId: ACCOUNT_ID,
              windowId: WINDOW_ID,
              expiredAt: EXPIRED_AT,
            },
          ],
        });
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    await vi.waitFor(() => {
      expect(startAgentPayloads).toHaveLength(1);
    });
  });

  it('does not dispatch backfilled activations after stop', async () => {
    const bus = createBusInstance();
    const startAgentPayloads: unknown[] = [];
    let resolvePending!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    cleanups.push(
      ...registerSuccessHandlers(bus, true, { startAgentPayloads }),
      bus.on(AccountManagerSubjects.usage.getPendingResets, async (ctx) => {
        await pendingGate;
        ctx.setResult({
          pending: [
            {
              clientId: CLIENT_ID,
              accountId: ACCOUNT_ID,
              windowId: WINDOW_ID,
              expiredAt: EXPIRED_AT,
            },
          ],
        });
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    activator.stop();
    resolvePending();
    await Promise.resolve();
    await Promise.resolve();

    expect(startAgentPayloads).toHaveLength(0);
  });

  it('keeps activation successful when the follow-up usage refresh fails', async () => {
    const bus = createBusInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanups.push(
      ...registerSuccessHandlers(bus, true),
      bus.on(AccountManagerSubjects.usage.refresh, () => {
        throw new Error('refresh unavailable');
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: unknown[] = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(activatedEvents).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[WindowActivator] Usage refresh after activation failed:',
        expect.objectContaining({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }),
      );
    });
  });

  it('does not emit usage.windowActivated when the adapter startAgent fails', async () => {
    const bus = createBusInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanups.push(...registerSuccessHandlers(bus, false));

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: unknown[] = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[WindowActivator] Ephemeral agent start failed:',
        expect.objectContaining({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }),
      );
    });
    expect(activatedEvents).toHaveLength(0);
  });

  it('stop() clears in-flight tracking and unsubscribes from bus events', async () => {
    const bus = createBusInstance();
    cleanups.push(...registerSuccessHandlers(bus, true));

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();

    const activatedEvents: unknown[] = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push(ctx.payload);
      }),
    );

    // Stop before any event — subscription should be removed.
    activator.stop();

    // Emit after stop — no activation should occur.
    await emitWindowReset(bus);
    // Small delay to allow any leaked async work to settle if the dedup guard failed.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(activatedEvents).toHaveLength(0);
  });

  it('uses defaultModel as fallback when fastModel is absent', async () => {
    const bus = createBusInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    cleanups.push(
      bus.on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
        ctx.setResult({
          configs: [
            {
              id: PROVIDER_CONFIG_ID,
              definitionId: DEFINITION_ID,
              name: 'Work Account',
              modelFilterMode: 'show-all' as const,
              isDefault: false,
              enabled: true,
              isSentinel: false,
              hasCredentials: true,
              sourceRef: ACCOUNT_REF,
            },
          ],
        });
      }),
      bus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: PROVIDER_CONFIG_ID,
            definitionId: DEFINITION_ID,
            credentialRefs: { token: ACCOUNT_REF },
          },
        });
      }),
      bus.on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
        ctx.setResult({
          bindings: [{ adapterName: ADAPTER_NAME, providerConfigId: PROVIDER_CONFIG_ID, isDefault: true }],
        });
      }),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: ADAPTER_ID });
      }),
      bus.on(ProviderStorageSubjects.get, (ctx) => {
        // No fastModel — only defaultModel is available.
        ctx.setResult({
          provider: {
            id: DEFINITION_ID,
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            defaultModel: 'claude-sonnet-4-6',
            // fastModel intentionally absent
            availableModels: [],
            defaultModelFilterMode: 'show-all' as const,
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        });
      }),
      bus.on(AdapterSubjects.startAgent, (ctx) => {
        ctx.setResult({
          success: true,
          agentId: 'agent-fallback-model',
          adapterId: ADAPTER_ID,
          adapterSessionId: 'session-fallback',
          sessionId: 'makaio-session-fallback',
        });
      }),
    );

    const activator = new WindowActivator(bus, makeConfig(true));
    activator.start();
    cleanups.push(() => activator.stop());

    const activatedEvents: Array<{ model: string }> = [];
    cleanups.push(
      bus.on(AccountManagerSubjects.usage.windowActivated, (ctx) => {
        activatedEvents.push({ model: ctx.payload.model });
      }),
    );

    await emitWindowReset(bus);

    await vi.waitFor(() => {
      expect(activatedEvents).toHaveLength(1);
    });
    expect(activatedEvents[0].model).toBe('claude-sonnet-4-6');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

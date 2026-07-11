import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type ResolvedProviderContext } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { activateProviderContext, resolveRuntimeProviderContext } from '@makaio/services-core/provider-context';
import { ProviderStorageSubjects } from '@makaio/services-core/settings/storage';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AutoActivationConfig } from '../account-manager-types.js';
import {
  authSelectsAccount,
  resolveProviderConfigsForAccount,
  type ResolvedProviderConfig,
} from '../provider-config-resolution.js';

/**
 * Resolved activation target for an ephemeral ping.
 *
 * Carries the three adapter-layer coordinates needed to start the agent:
 * the live adapter instance ID, the model to use, and the validated refs-only
 * provider context the connector will expand locally.
 */
interface ActivationTarget {
  /** Live adapter instance identifier from the runtime registry. */
  adapterId: string;
  /** Model slug selected for the ping (fast model preferred). */
  model: string;
  /** Validated refs-only provider context passed through to the connector. */
  providerContext: ResolvedProviderContext;
}

/** Adapter binding and exact account-selected context chosen for activation. */
interface ActivationProviderSelection {
  /** Adapter whose binding selected the provider config. */
  readonly adapterName: string;
  /** Exact account-pinned provider context carried into startup. */
  readonly providerContext: ResolvedProviderContext;
}

/**
 * Orchestrates automatic usage-window activation.
 *
 * Subscribes to `usage.windowResetAvailable` events and dispatches a minimal
 * ephemeral "ping" through the adapter pipeline to open a new usage window.
 * This prevents the user's first real message from being delayed by the
 * provider's window-reset latency.
 *
 * All resolution steps use `bus.requestOptional` so that a missing service
 * (adapter subsystem not yet started, no binding configured, etc.) degrades
 * silently rather than crashing — the user's next natural message will open
 * the window instead.
 */
export class WindowActivator {
  private readonly bus: IMakaioBus;
  private readonly config: AutoActivationConfig;

  /**
   * Deduplication set for in-flight activations.
   * Key format: JSON tuple `[clientId, accountId, windowId, expiredAt]`.
   */
  private readonly inFlight = new Set<string>();

  private readonly cleanups: Array<() => void> = [];

  /** Monotonic ownership token for async work started by `start()`. */
  private lifecycleGeneration = 0;

  /**
   * @param bus - Bus instance used for subscriptions and RPCs
   * @param config - Auto-activation configuration including per-source opt-in flags
   */
  public constructor(bus: IMakaioBus, config: AutoActivationConfig) {
    this.bus = bus;
    this.config = config;
  }

  /**
   * Subscribes to `usage.windowResetAvailable` and starts processing events.
   */
  public start(): void {
    const generation = ++this.lifecycleGeneration;
    this.cleanups.push(
      this.bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
        const { clientId, accountId, windowId, expiredAt } = ctx.payload;
        void this.activate(clientId, accountId, windowId, expiredAt, generation);
      }),
    );
    void this.backfillPendingResets(generation).catch(() => {
      console.warn('[WindowActivator] Pending reset backfill failed.');
    });
  }

  /**
   * Unsubscribes from bus events and clears in-flight tracking.
   */
  public stop(): void {
    this.lifecycleGeneration++;
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.inFlight.clear();
  }

  /**
   * Deduplicates and gates the activation pipeline for a single reset event.
   *
   * Returns silently when auto-activation is disabled for the client, or when
   * an identical activation is already in-flight. Cleans up the in-flight entry
   * once the pipeline completes (success or failure).
   * @param clientId - Account-manager source identifier
   * @param accountId - Stable account identifier
   * @param windowId - Usage window slug (e.g. `"5h"`)
   * @param expiredAt - Epoch ms of the expired window reset timestamp
   * @param generation - Lifecycle generation that owns this activation
   */
  private async activate(
    clientId: string,
    accountId: string,
    windowId: string,
    expiredAt: number,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    const sourceConfig = this.config.sources.get(clientId);
    if (!sourceConfig?.enabled) {
      return;
    }

    const dedupeKey = JSON.stringify([clientId, accountId, windowId, expiredAt]);
    if (this.inFlight.has(dedupeKey)) {
      return;
    }
    this.inFlight.add(dedupeKey);

    try {
      await this.runActivationPipeline(clientId, accountId, windowId, generation);
    } catch {
      console.warn('[WindowActivator] Activation pipeline failed:', {
        clientId,
        accountId,
        windowId,
      });
    } finally {
      this.inFlight.delete(dedupeKey);
    }
  }

  /**
   * Dispatches the ephemeral ping and emits observability events.
   *
   * Resolves the full adapter-layer target first; returns early without error
   * when any resolution step fails (graceful degradation). On success, emits
   * `usage.windowActivated` and triggers a best-effort usage refresh.
   * @param clientId - Account-manager source identifier
   * @param accountId - Stable account identifier
   * @param windowId - Usage window slug (e.g. `"5h"`)
   * @param generation - Lifecycle generation that owns this activation
   */
  private async runActivationPipeline(
    clientId: string,
    accountId: string,
    windowId: string,
    generation: number,
  ): Promise<void> {
    const target = await this.resolveActivationTarget(clientId, accountId);
    if (!target || !this.isCurrentGeneration(generation)) {
      return;
    }
    const { adapterId, model, providerContext } = target;

    await activateProviderContext(this.bus, providerContext);
    if (!this.isCurrentGeneration(generation)) {
      return;
    }

    const startResult = await this.bus.requestOptional(AdapterSubjects.startAgent, {
      adapterId,
      role: 'lead' as const,
      ephemeral: true,
      model,
      providerContext,
      initialMessage: this.config.message,
      systemPrompt: this.config.systemPrompt,
    });

    if (!this.isCurrentGeneration(generation)) {
      return;
    }

    if (!startResult.handled) {
      console.warn('[WindowActivator] Adapter not available to start ephemeral agent:', {
        clientId,
        accountId,
        adapterId,
      });
      return;
    }

    if (!startResult.data.success) {
      console.warn('[WindowActivator] Ephemeral agent start failed:', {
        clientId,
        accountId,
        adapterId,
      });
      return;
    }

    await this.bus.emit(AccountManagerSubjects.usage.windowActivated, {
      clientId,
      accountId,
      windowId,
      model,
    });

    // Best-effort usage refresh is fire-and-forget so activation deduplication
    // is released promptly; failures are logged for observability.
    void this.bus
      .requestOptional(AccountManagerSubjects.usage.refresh, {
        clientId,
        accountId,
      })
      .catch(() => {
        console.warn('[WindowActivator] Usage refresh after activation failed:', {
          clientId,
          accountId,
          windowId,
        });
      });
  }

  /**
   * Resolves the adapter-layer coordinates required to dispatch a ping.
   *
   * Walks steps 1–4 of the resolution chain — candidate provider config,
   * binding-qualified runtime context, live adapter ID, and fast model — returning
   * `null` with a warning log at any step that cannot be resolved.
   * @param clientId - Account-manager source identifier
   * @param accountId - Stable account identifier
   * @returns Resolved target, or `null` when any step fails
   */
  private async resolveActivationTarget(clientId: string, accountId: string): Promise<ActivationTarget | null> {
    // Step 1: Resolve candidate provider configs for this account.
    const providerConfigs = await resolveProviderConfigsForAccount(this.bus, clientId, accountId);
    if (providerConfigs.length === 0) {
      console.warn('[WindowActivator] No provider config found for account:', { clientId, accountId });
      return null;
    }

    const selected = await this.selectProviderContext(providerConfigs, clientId, accountId);
    if (selected === null) return null;
    const { adapterName, providerContext } = selected;

    // Step 3: Resolve live adapter instance ID from the selected binding.
    const resolveIdResult = await this.bus.requestOptional(AdapterRuntimeSubjects.resolveId, {
      adapterName,
    });
    if (!resolveIdResult.handled) {
      console.warn('[WindowActivator] Adapter runtime unavailable for ID resolution:', {
        clientId,
        accountId,
        adapterName,
      });
      return null;
    }

    // Step 4: Fetch the provider definition from the same atomic context.
    const { definitionId } = providerContext;
    const providerResult = await this.bus.requestOptional(ProviderStorageSubjects.get, { id: definitionId });
    if (!providerResult.handled || !providerResult.data.provider) {
      console.warn('[WindowActivator] Provider definition not found:', { clientId, accountId, definitionId });
      return null;
    }
    const model = providerResult.data.provider.fastModel ?? providerResult.data.provider.defaultModel;
    if (!model) {
      console.warn('[WindowActivator] No model available for provider:', { clientId, accountId, definitionId });
      return null;
    }

    return { adapterId: resolveIdResult.data.adapterId, model, providerContext };
  }

  /**
   * Select the first bound runtime context that pins the reset event's account.
   * @param providerConfigs - Candidate inferred configs for the client.
   * @param clientId - Client that owns the reset account.
   * @param accountId - Exact reset account identifier.
   * @returns Adapter-qualified account selection, or null with a diagnostic warning.
   */
  private async selectProviderContext(
    providerConfigs: readonly ResolvedProviderConfig[],
    clientId: string,
    accountId: string,
  ): Promise<ActivationProviderSelection | null> {
    let foundBinding = false;
    let resolvedContext = false;
    for (const config of providerConfigs) {
      const bindingsResult = await this.bus.requestOptional(AdapterSubsystemSubjects.listBindingsByConfig, {
        providerConfigId: config.providerConfigId,
      });
      if (!bindingsResult.handled) {
        console.warn('[WindowActivator] Adapter subsystem unavailable for binding lookup:', {
          clientId,
          accountId,
          providerConfigId: config.providerConfigId,
        });
        return null;
      }
      const defaultBinding =
        bindingsResult.data.bindings.find((binding) => binding.isDefault) ?? bindingsResult.data.bindings[0];
      if (!defaultBinding) continue;
      foundBinding = true;

      let candidate: ResolvedProviderContext;
      try {
        candidate = await resolveRuntimeProviderContext(this.bus, {
          adapterName: defaultBinding.adapterName,
          providerConfigId: config.providerConfigId,
        });
      } catch {
        continue;
      }
      resolvedContext = true;
      if (authSelectsAccount(candidate.auth, clientId, accountId)) {
        return { adapterName: defaultBinding.adapterName, providerContext: candidate };
      }
    }

    const message = !foundBinding
      ? '[WindowActivator] No binding found for provider config:'
      : resolvedContext
        ? '[WindowActivator] No exact account-selected provider context found:'
        : '[WindowActivator] Could not resolve adapter-qualified provider context:';
    console.warn(message, {
      clientId,
      accountId,
      providerConfigId: providerConfigs[0]?.providerConfigId,
    });
    return null;
  }

  /**
   * Activates reset windows that were already cached before this handler started.
   * @param generation - Lifecycle generation that owns the backfill pass
   * @returns Nothing
   */
  private async backfillPendingResets(generation: number): Promise<void> {
    const pendingResult = await this.bus.requestOptional(AccountManagerSubjects.usage.getPendingResets, {});
    if (!pendingResult.handled || !this.isCurrentGeneration(generation)) {
      return;
    }
    for (const reset of pendingResult.data.pending) {
      await this.activate(reset.clientId, reset.accountId, reset.windowId, reset.expiredAt, generation);
    }
  }

  /**
   * Checks whether async work is still owned by the current start lifecycle.
   * @param generation - Lifecycle generation captured when the work started
   * @returns Whether this activator is still in the same lifecycle
   */
  private isCurrentGeneration(generation: number): boolean {
    return this.lifecycleGeneration === generation;
  }
}

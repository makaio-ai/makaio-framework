import {
  IsolationLevelSchema,
  WorkerAllocationLifetimeSchema,
  MaxRuntimeAssuranceSchema,
  WorkerCapabilitiesSchema,
  WorkerProviderIdSchema,
  WorkerProviderKeySchema,
} from '@makaio/contracts';
import { ContributionNameSchema, localContributionName, type CallContext, type ExtensionName } from '@makaio/core';
import type { OrderedWorkerProvider } from './ordered-provider.js';

const capabilitiesSchema = WorkerCapabilitiesSchema.extend({
  maxRuntimeMs: WorkerCapabilitiesSchema.shape.maxRuntimeMs.unwrap(),
  stepIsolation: IsolationLevelSchema,
});

/** Activation-time batch and its validated configuration and installation state. */
export interface WorkerProviderActivation {
  readonly owner: ExtensionName;
  readonly key: string;
  readonly managedScopeConfirmed: boolean;
  readonly providers: readonly OrderedWorkerProvider[];
}

/** Separate selection of new allocations from resolution of outstanding ones. */
export class WorkerProviderRegistry {
  private readonly owners = new Map<ExtensionName, ReadonlyMap<string, OrderedWorkerProvider>>();
  private readonly retained = new Map<string, { owner: ExtensionName; provider: OrderedWorkerProvider }>();

  /**
   * Validate the whole batch off-registry, then replace the previous contribution.
   * The extension lifecycle serializes activations for the same owner.
   * @param call - Activation call carried to the provider.
   * @param activation - Contributions built from validated extension config.
   * @param signal - Activation lifetime.
   */
  public async replace(call: CallContext, activation: WorkerProviderActivation, signal: AbortSignal): Promise<void> {
    const key = WorkerProviderKeySchema.parse(activation.key);
    const next = new Map<string, OrderedWorkerProvider>();
    for (const input of activation.providers) {
      const provider = await validateProvider(call, activation, key, input, signal);
      if (next.has(provider.id)) throw new Error('Duplicate worker provider instance');
      next.set(provider.id, provider);
    }
    signal.throwIfAborted();
    for (const provider of next.values()) {
      const existing = this.retained.get(provider.id);
      if (
        existing !== undefined &&
        (existing.owner !== activation.owner ||
          existing.provider.allocationLifetime !== provider.allocationLifetime ||
          existing.provider.startValuesVisibility !== provider.startValuesVisibility)
      ) {
        throw new Error(
          'Worker provider instance identity cannot change ownership, lifetime or start value visibility',
        );
      }
    }
    this.owners.set(activation.owner, next);
    for (const provider of next.values()) this.retained.set(provider.id, { owner: activation.owner, provider });
  }

  /**
   * Resolve an instance still needed by allocation supervision.
   * @param id - Stable provider instance ID.
   * @returns An instance resolvable for an open obligation.
   */
  public get(id: string): OrderedWorkerProvider | undefined {
    return this.retained.get(id)?.provider;
  }

  /**
   * Resolve a currently selectable instance.
   * @param id - Stable provider instance ID.
   * @returns The active instance, if selectable.
   */
  public selectForProvisioning(id: string): OrderedWorkerProvider | undefined {
    for (const providers of this.owners.values()) {
      const provider = providers.get(id);
      if (provider !== undefined) return provider;
    }
    return undefined;
  }

  /**
   * List validated declarations available for ordering.
   * @returns The active provider declarations.
   */
  public listSelectable(): readonly OrderedWorkerProvider[] {
    return [...this.owners.values()].flatMap((providers) => [...providers.values()]);
  }
}

/**
 * Check ownership, configuration, lifetime and the executable recovery surface.
 * @param call - Activation call.
 * @param activation - Contribution owner's validated configuration.
 * @param key - Stable instance key.
 * @param input - Provider awaiting activation.
 * @param signal - Activation lifetime.
 * @returns The validated provider registration.
 */
async function validateProvider(
  call: CallContext,
  activation: WorkerProviderActivation,
  key: string,
  input: OrderedWorkerProvider,
  signal: AbortSignal,
): Promise<OrderedWorkerProvider> {
  const kind = ContributionNameSchema.parse(input.kind);
  WorkerAllocationLifetimeSchema.parse(input.allocationLifetime);
  if (
    localContributionName(activation.owner, kind) === undefined ||
    WorkerProviderIdSchema.parse(input.id) !== `${kind}:${key}`
  ) {
    throw new Error('Worker provider instance identity does not match its owner and configuration');
  }
  if (
    input.allocationLifetime === 'provider-managed' &&
    (!activation.managedScopeConfirmed ||
      ![
        input.recovery?.listAllocations,
        input.recovery?.attach,
        input.recovery?.inspect,
        input.recovery?.terminateAllocation,
      ].every((operation) => typeof operation === 'function'))
  ) {
    throw new Error('Managed worker provider requires confirmed scope and recovery');
  }
  if (input.startValuesVisibility !== 'allocation-only' && input.startValuesVisibility !== 'externally-visible') {
    throw new Error('Worker provider must declare start value visibility');
  }
  const capabilities = capabilitiesSchema.parse(input.capabilities);
  if (input.allocationLifetime === 'provisioner-process-bound') {
    if (typeof input.proveLocalLive !== 'function') {
      throw new Error('Process-bound worker provider requires proveLocalLive()');
    }
    if (capabilities.supportsRecovery) {
      throw new Error('Process-bound worker provider cannot advertise recovery');
    }
  }
  const assurance = MaxRuntimeAssuranceSchema.parse(await input.assureMaxRuntime(call, signal));
  if (input.allocationLifetime === 'provider-managed' && assurance.boundary !== 'platform') {
    throw new Error('Managed worker provider requires platform runtime enforcement');
  }
  Object.freeze(capabilities.customCapabilities);
  Object.freeze(capabilities.materializationModes);
  const registration = {
    kind,
    id: input.id,
    startValuesVisibility: input.startValuesVisibility,
    capabilities: Object.freeze(capabilities),
    assureMaxRuntime: input.assureMaxRuntime.bind(input),
    provision: input.provision.bind(input),
  };
  if (input.allocationLifetime === 'provisioner-process-bound') {
    return Object.freeze({
      ...registration,
      allocationLifetime: input.allocationLifetime,
      proveLocalLive: input.proveLocalLive.bind(input),
    });
  }
  const recovery = input.recovery;
  return Object.freeze({
    ...registration,
    allocationLifetime: input.allocationLifetime,
    recovery: Object.freeze({
      listAllocations: recovery.listAllocations.bind(recovery),
      attach: recovery.attach.bind(recovery),
      inspect: recovery.inspect.bind(recovery),
      terminateAllocation: recovery.terminateAllocation.bind(recovery),
      proveUniqueLive: recovery.proveUniqueLive?.bind(recovery),
      proveSealed: recovery.proveSealed?.bind(recovery),
    }),
  });
}

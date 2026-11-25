import type { ExtensionContext } from '../extension-context.js';
import type { OrderedWorkerProvider } from './ordered-worker-provider.js';

/** Provider batch supplied by one extension activation. */
export interface WorkerProviderContribution {
  /** Stable instance key used in the provider IDs. */
  readonly key: string;
  /** Whether the installation confirms the scope for managed allocations. */
  readonly managedScopeConfirmed: boolean;
  /**
   * Providers available for ordering during the activation. Their recovery
   * methods must remain usable after the extension stops for as long as
   * outstanding allocations still require cleanup. After the extension stops,
   * `provision` must honor its abort signal and `WorkerHandle.terminate` must remain
   * usable. A provider ID identifies one durable backend. Later activations using
   * the same ID must be able to observe and clean up allocations created by earlier
   * activations. A different backend requires a new ID.
   */
  readonly providers: readonly OrderedWorkerProvider[];
}

/**
 * Executable worker provider contribution declared by an extension.
 * @typeParam TContext - Runtime context supplied by the host during activation.
 */
export interface ExtensionWorkerProvidersContribution<TContext extends ExtensionContext = ExtensionContext> {
  /**
   * Build the batch from the extension's activation context. The host registers
   * it under the extension's identity and withdraws it when the extension stops.
   * @param ctx - Context of the activating extension.
   * @returns Provider batch or a promise resolving to it.
   */
  readonly createProviders: (ctx: TContext) => WorkerProviderContribution | Promise<WorkerProviderContribution>;
}

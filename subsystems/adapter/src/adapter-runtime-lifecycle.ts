/**
 * Adapter runtime lifecycle utilities.
 *
 * The 8-step bootstrap ceremony (`bootstrapAdapterRuntime`) and its
 * associated types (`AdapterRuntimeContext`, `DynamicLoadContext`,
 * `AdapterDiscovery`) have been removed as part of the D2 bus-decoupled
 * lifecycle migration. Adapter packages are now processed incrementally
 * by `AdapterSubsystemService` reacting to `extension.stateChanged` events.
 *
 * The following utilities are preserved because they remain in use:
 * - {@link extractAdapterIdFromPackageName} — stable short-name derivation
 * - {@link toAvailableAdapter} — settings-facing adapter shape conversion
 * - {@link shutdownAdapterInstances} — best-effort shutdown of live instances
 * - {@link initializeEnabledAdapters} — factory invocation for enabled adapters
 * - {@link ensureAdapterConfigs} — file-backed config bootstrap
 * @see {@link AdapterSubsystemService} for the event-driven replacement.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '@makaio/services-core/adapter-runtime';
import { AdapterSubsystemSubjects } from './namespace.js';
import type { AvailableAdapter } from '@makaio/services-core/settings';
import type { LoadedAdapter, AdapterInstance, AdapterInitOptions } from './adapter-runtime-types.js';
import { resolveDefaultClientId } from './adapter-client-refs.js';
import {
  AdapterInstanceCloseTimeoutError,
  aggregateAdapterInstanceTeardowns,
  classifyAdapterInstanceClose,
  type AdapterInstanceShutdownReport,
  type AdapterInstanceTeardownResult,
} from './adapter-instance-teardown.js';

/** Maximum time to wait for an adapter instance close hook before continuing shutdown. */
export const ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS = 5_000;

type AdapterCloseHook = () => void | Promise<void>;

interface CloseableAdapterInstance extends AdapterInstance {
  readonly shutdown?: AdapterCloseHook;
  readonly closeAsync?: AdapterCloseHook;
  readonly close?: AdapterCloseHook;
}

// ---------------------------------------------------------------------------
// Re-exported public types
// ---------------------------------------------------------------------------

/**
 * Platform-provided defaults injected by the runtime host.
 *
 * Mirrors the shape of `PlatformDefaults` from `@makaio/ai-adapters-core`
 * without taking a dependency on the host-layer package.
 */
export interface PlatformDefaults {
  /** Default working directory for agent execution (e.g. `os.tmpdir()` on Node.js). */
  cwd?: string;
  /** Default environment variables. */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Derive a stable adapter short name from an NPM package name.
 *
 * Examples:
 * - `@makaio/ai-adapters-claude-code` → `'claude-code'`
 * - `@scope/ai-adapters-gemini` → `'gemini'`
 * - `some-package` → `'some-package'` (fallback: full name)
 * @param packageName - NPM package name for the adapter.
 * @returns Non-empty stable identifier used for deterministic routing.
 */
export function extractAdapterIdFromPackageName(packageName: string): string {
  const extracted = packageName
    .split('/')
    .pop()
    ?.replace(/^ai-adapters-/, '')
    ?.trim();
  return extracted && extracted.length > 0 ? extracted : packageName;
}

/**
 * Convert a loaded adapter definition to the settings-facing `AvailableAdapter` shape.
 * @param adapter - Loaded adapter definition.
 * @returns Adapter metadata safe to forward beyond bootstrap.
 */
export function toAvailableAdapter(adapter: LoadedAdapter): AvailableAdapter {
  const clientId = resolveDefaultClientId(adapter.options, adapter.clients);

  return {
    name: adapter.name,
    displayName: adapter.displayName ?? adapter.name,
    description: adapter.description,
    helpLinks: adapter.helpLinks?.map((link) => ({ ...link })),
    instructions: adapter.instructions,
    clientId,
    protocol: adapter.protocol,
    providerDefinitionIds: [...adapter.providerDefinitionIds],
  };
}

/**
 * Close one adapter instance through its supported lifecycle hook.
 *
 * Still **throws**, because the three callers that roll an instance back build
 * their own failure from the exception. What changed is that the failure now says
 * which of the two things happened: a hook that outlives its budget raises
 * {@link AdapterInstanceCloseTimeoutError}, so a caller reporting the attempt can
 * tell "it reported a failure" from "it reported nothing".
 * @param adapterId - Runtime adapter ID used for diagnostics.
 * @param instance - Adapter instance to close.
 * @param timeoutMs - Maximum time to wait for the close hook.
 * @throws AdapterInstanceCloseTimeoutError When the hook does not return in time.
 */
export async function closeAdapterInstance(
  adapterId: string,
  instance: AdapterInstance,
  timeoutMs = ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const closeHook = resolveAdapterCloseHook(instance);
  if (!closeHook) {
    return;
  }
  await runAdapterCloseHook(adapterId, closeHook, timeoutMs);
}

/**
 * Run an already-resolved close hook under its budget.
 *
 * Split from {@link closeAdapterInstance} for the one caller that must know
 * *whether there was a hook* in order to classify the attempt: resolving the hook
 * twice to answer that would let the two resolutions disagree about which of
 * `shutdown`/`closeAsync`/`close` an instance exposes. Callers that only need the
 * close go through {@link closeAdapterInstance}.
 * @param adapterId - Runtime adapter ID used for diagnostics.
 * @param closeHook - Hook resolved from the instance.
 * @param timeoutMs - Maximum time to wait for the hook.
 * @throws AdapterInstanceCloseTimeoutError When the hook does not return in time.
 */
async function runAdapterCloseHook(adapterId: string, closeHook: AdapterCloseHook, timeoutMs: number): Promise<void> {
  const hookSettled = Promise.resolve().then(closeHook);
  // A hook that rejects *after* losing the race below has no consumer left, and an
  // unobserved rejection would take the whole shutdown down with it. The timeout is
  // already the reported outcome, so the late failure is only kept from escaping.
  // Attaching this handler does not remove the rejection from the race.
  hookSettled.catch(() => undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hookSettled,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new AdapterInstanceCloseTimeoutError(adapterId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Shut down all adapter instances, report each one, and clear the map.
 *
 * **A timed-out instance is no longer indistinguishable from a clean close**
 * (Wave 3 R49). Every instance is still attempted and the map is still cleared —
 * one adapter that will not let go must not keep the others hosted — but the
 * shutdown now says what it observed per instance and in aggregate, because the
 * only consumer that could act on it is one that knows whether anything is still
 * running.
 *
 * The instances are closed **concurrently**. They are independent resources and no
 * consumer of this report depends on the order they let go in, whereas serialising
 * them meant one adapter that will not let go spent the whole close budget before
 * the next one was even asked — so a host with several stuck adapters waited a
 * multiple of a budget it had declared once. Result order still follows the map, so
 * the per-instance breakdown reads the same as before.
 * @param instances - Mutable map of adapter instances to shut down.
 * @returns Per-instance results and the class standing for all of them.
 */
export async function shutdownAdapterInstances(
  instances: Map<string, AdapterInstance>,
): Promise<AdapterInstanceShutdownReport> {
  const results = await Promise.all(
    [...instances].map(([adapterId, instance]) => shutDownOneAdapterInstance(adapterId, instance)),
  );
  instances.clear();
  return aggregateAdapterInstanceTeardowns(results);
}

/**
 * Close one instance during shutdown and classify what the attempt proved.
 *
 * Never rejects: a shutdown reports every instance, so a failure here is an
 * outcome to classify rather than one to propagate past the siblings.
 * @param adapterId - Runtime adapter ID being closed.
 * @param instance - Instance to close.
 * @returns The class this attempt proves.
 */
async function shutDownOneAdapterInstance(
  adapterId: string,
  instance: AdapterInstance,
): Promise<AdapterInstanceTeardownResult> {
  const closeHook = resolveAdapterCloseHook(instance);
  let failure: unknown;
  if (closeHook !== undefined) {
    try {
      await runAdapterCloseHook(adapterId, closeHook, ADAPTER_INSTANCE_CLOSE_TIMEOUT_MS);
    } catch (shutdownError) {
      failure = shutdownError;
      console.error(`[adapter-runtime] Error shutting down adapter ${adapterId}:`, shutdownError);
    }
  }
  return classifyAdapterInstanceClose(adapterId, failure, closeHook !== undefined);
}

/**
 * Roll back a live instance that was stored before its initialized event fully
 * published.
 * @param adapterId - Runtime adapter ID used as the instance map key.
 * @param instance - Instance to shut down before removal.
 * @param instances - Mutable instance registry.
 */
async function rollbackInitializedAdapterInstance(
  adapterId: string,
  instance: AdapterInstance,
  instances: Map<string, AdapterInstance>,
): Promise<void> {
  try {
    await closeAdapterInstance(adapterId, instance);
  } finally {
    instances.delete(adapterId);
  }
}

/**
 * Check whether an adapter is enabled in file-backed settings.
 * @param bus - Bus instance used for adapter-subsystem requests.
 * @param adapterName - Adapter driver name.
 * @returns `true` when the adapter config exists and is enabled.
 */
async function isAdapterEnabled(bus: IMakaioBus, adapterName: string): Promise<boolean> {
  const { config } = await bus.request(AdapterSubsystemSubjects.getAdapterConfig, { name: adapterName });
  return config?.enabled ?? false;
}

/**
 * Resolve the runtime adapter ID using the same fallback as initialization.
 * @param adapter - Loaded adapter entry.
 * @param machineId - Current machine identifier.
 * @returns Explicit adapter ID or deterministic runtime ID.
 */
export function resolveLoadedAdapterId(adapter: LoadedAdapter, machineId: string): string {
  return adapter.options.adapterId ?? buildDeterministicAdapterId(machineId, adapter.name);
}

/**
 * Pick the lifecycle hook used to close an adapter instance.
 * @param instance - Adapter instance returned by a factory.
 * @returns Close hook, or undefined when the instance exposes none.
 */
function resolveAdapterCloseHook(instance: AdapterInstance): AdapterCloseHook | undefined {
  const closeable = instance as CloseableAdapterInstance;
  if (typeof closeable.shutdown === 'function') {
    return closeable.shutdown.bind(instance);
  }
  if (typeof closeable.closeAsync === 'function') {
    return closeable.closeAsync.bind(instance);
  }
  if (typeof closeable.close === 'function') {
    return closeable.close.bind(instance);
  }
  return undefined;
}

/**
 * Initialize the subset of loaded adapters that are enabled in settings.
 * @param bus - Bus instance used for adapter-subsystem requests.
 * @param machineId - Current machine identifier.
 * @param adapters - Loaded adapter definitions to initialize.
 * @param adapterInstances - Mutable instance registry.
 * @param platformDefaults - Platform-provided adapter defaults.
 */
export async function initializeEnabledAdapters(
  bus: IMakaioBus,
  machineId: string,
  adapters: readonly LoadedAdapter[],
  adapterInstances: Map<string, AdapterInstance>,
  platformDefaults: PlatformDefaults,
): Promise<void> {
  const failedAdapters: Array<{ adapterName: string; error: unknown }> = [];

  for (const adapter of adapters) {
    try {
      if (!(await isAdapterEnabled(bus, adapter.name))) {
        console.info(`Skipping disabled adapter: ${adapter.name}`);
        continue;
      }

      const expectedAdapterId = resolveLoadedAdapterId(adapter, machineId);
      const clientId = resolveDefaultClientId(adapter.options, adapter.clients);
      const instance = await adapter.factory({
        ...adapter.options,
        adapterId: expectedAdapterId,
        platformDefaults,
        definitionProviders: adapter.providers,
        clientId,
        globalBus: bus,
      } as AdapterInitOptions);

      if (instance.adapterId !== expectedAdapterId) {
        const mismatchError = new Error(
          `Adapter '${adapter.name}' initialized with mismatched adapterId (expected '${expectedAdapterId}', got '${instance.adapterId}')`,
        );
        try {
          await closeAdapterInstance(expectedAdapterId, instance);
        } catch (rollbackError) {
          console.error(`[adapter-runtime] Error rolling back adapter ${adapter.name}:`, rollbackError);
        }
        throw mismatchError;
      }

      adapterInstances.set(expectedAdapterId, instance);
      const initializedMetadata = instance as AdapterInstance & {
        readonly capabilities?: readonly string[];
        readonly nativeTools?: readonly string[];
      };
      try {
        await bus.emit(AdapterSubjects.initialized, {
          adapterId: expectedAdapterId,
          adapterName: adapter.name,
          capabilities: [...(initializedMetadata.capabilities ?? [])],
          ...(initializedMetadata.nativeTools !== undefined
            ? { nativeTools: [...initializedMetadata.nativeTools] }
            : {}),
        });
      } catch (emitError) {
        try {
          await rollbackInitializedAdapterInstance(expectedAdapterId, instance, adapterInstances);
        } catch (rollbackError) {
          console.error(`[adapter-runtime] Error rolling back adapter ${adapter.name}:`, rollbackError);
        }
        throw emitError;
      }
      console.info(`Initialized adapter: ${adapter.name} (${adapter.packageName})`);
    } catch (error) {
      failedAdapters.push({ adapterName: adapter.name, error });
    }
  }

  if (failedAdapters.length > 0) {
    const failures = failedAdapters
      .map(({ adapterName, error }) => {
        const message = error instanceof Error ? error.message : String(error);
        return `${adapterName}: ${message}`;
      })
      .join('; ');
    throw new Error(`Failed to initialize enabled adapters: ${failures}`);
  }
}

/**
 * Ensure a file-backed adapter config exists for each loaded adapter.
 *
 * Missing configs are created with `enabled: false` so boot does not silently
 * activate newly discovered adapters.
 * @param adapters - Loaded adapter definitions to register or update.
 * @param bus - Bus instance used for adapter-subsystem requests.
 */
export async function ensureAdapterConfigs(adapters: LoadedAdapter[], bus: IMakaioBus): Promise<void> {
  await bus.request(AdapterSubsystemSubjects.ensureReady, {});
  const adapterConfigs = await Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      config: (await bus.request(AdapterSubsystemSubjects.getAdapterConfig, { name: adapter.name })).config,
    })),
  );

  await Promise.all(
    adapterConfigs
      .filter(({ config }) => !config)
      .map(({ adapter }) =>
        bus.request(AdapterSubsystemSubjects.setAdapterConfig, {
          name: adapter.name,
          patch: {
            displayName: adapter.displayName,
            description: adapter.description,
            helpLinks: adapter.helpLinks?.map((link) => ({ ...link })),
            instructions: adapter.instructions,
            clientId: resolveDefaultClientId(adapter.options, adapter.clients),
            protocol: adapter.protocol,
            providerDefinitionIds: [...adapter.providerDefinitionIds],
            enabled: false,
          },
        }),
      ),
  );
}

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
 * @param adapterId - Runtime adapter ID used for diagnostics.
 * @param instance - Adapter instance to close.
 * @param timeoutMs - Maximum time to wait for the close hook.
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

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(closeHook),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out closing adapter ${adapterId} after ${timeoutMs}ms`));
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
 * Best-effort shutdown of all adapter instances and clear the map.
 * @param instances - Mutable map of adapter instances to shut down.
 */
export async function shutdownAdapterInstances(instances: Map<string, AdapterInstance>): Promise<void> {
  for (const [adapterId, instance] of instances) {
    try {
      await closeAdapterInstance(adapterId, instance);
    } catch (shutdownError) {
      console.error(`[adapter-runtime] Error shutting down adapter ${adapterId}:`, shutdownError);
    }
  }
  instances.clear();
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

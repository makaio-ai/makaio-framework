/**
 * Capability-provider integration for the log-import registry.
 *
 * Encapsulates the logic that bridges the capability bus event system with
 * the registry: provider shape validation, orchestrator factory construction,
 * mode restoration, and the live subscription + backfill initialization.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type {
  LogImportConfig,
  LogImportOrchestrator,
  LogImportRegistration as AdapterLogImportRegistration,
  LogOrchestratorConfig,
  LogOrchestratorConstructor,
} from '@makaio/ai-adapters-core';
import { CapabilitySubjects } from '@makaio/contracts';
import type { CapabilityService } from '@makaio/services-core/capability';
import { LogImportSubjects } from './namespace.js';
import type { LogImportMode } from './schemas/index.js';
import type { LogImporterRegistration, OrchestratorFactory } from './types.js';
import { classifyLogImporterSource } from './log-import-source.js';

/**
 * Minimal registry API required to register providers from capability events.
 *
 * `LogImportRegistry` satisfies this interface structurally, enabling the
 * capability integration module to remain decoupled from the concrete class.
 */
export interface CapabilityProviderRegistrar {
  /**
   * Returns the registration entry for an importer ID, or `undefined`.
   * @param importerId - Unique importer ID
   */
  getImporter(importerId: string): LogImporterRegistration | undefined;
  /**
   * Registers a new importer.
   * @param registration - Importer registration data
   */
  register(registration: LogImporterRegistration): Promise<void>;
  /**
   * Attaches an orchestrator factory to a registered importer.
   * @param importerId - Unique importer ID
   * @param factory - Factory function for mode-specific orchestrators
   */
  setOrchestratorFactory(importerId: string, factory: OrchestratorFactory): void;
  /**
   * Switches the import mode for a registered importer.
   * @param importerId - Unique importer ID
   * @param mode - Target import mode
   */
  switchMode(importerId: string, mode: LogImportMode): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal provider shape
// ---------------------------------------------------------------------------

interface CapabilityLogImportProvider {
  id: string;
  displayName: string;
  adapterName: string;
  registration: AdapterLogImportRegistration;
  logImportConfig?: LogImportConfig;
  /** Machine identifier forwarded from the product descriptor at registration time. */
  machineId?: string | null;
}

/**
 * Check whether a capability provider payload is a log-import provider.
 * @param provider - Capability provider payload to validate
 * @returns True when the payload matches the log-import provider shape
 */
function isLogImportProvider(provider: unknown): provider is CapabilityLogImportProvider {
  if (!provider || typeof provider !== 'object') {
    return false;
  }

  const candidate = provider as Partial<CapabilityLogImportProvider>;
  const registration = candidate.registration;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.adapterName === 'string' &&
    !!registration &&
    typeof registration === 'object' &&
    typeof registration.LogImporterClass === 'function' &&
    typeof registration.logFilePattern === 'string' &&
    (registration.LogOrchestratorClass === undefined || typeof registration.LogOrchestratorClass === 'function') &&
    (registration.LogDiscoveryOrchestratorClass === undefined ||
      typeof registration.LogDiscoveryOrchestratorClass === 'function')
  );
}

// ---------------------------------------------------------------------------
// Orchestrator factory construction
// ---------------------------------------------------------------------------

/**
 * Build orchestrator config from adapter runtime metadata.
 *
 * The returned config preserves the adapter-level enable flag so persisted
 * modes cannot restart an importer that runtime config disabled.
 * @param adapterId - Runtime adapter UUID
 * @param adapterName - Stable adapter name
 * @param logImportConfig - Optional per-adapter log import configuration
 * @param machineId - Machine identifier forwarded from the product descriptor
 * @returns Normalized orchestrator configuration
 */
function buildOrchestratorConfig(
  adapterId: string,
  adapterName: string,
  logImportConfig?: LogImportConfig,
  machineId?: string | null,
): LogOrchestratorConfig {
  return {
    enabled: logImportConfig?.enabled ?? true,
    pollIntervalMs: logImportConfig?.pollIntervalMs,
    eventsPerSecond: logImportConfig?.eventsPerSecond,
    adapterId,
    adapterName,
    checkMakaioManaged: logImportConfig?.checkMakaioManaged,
    machineId,
  };
}

/**
 * Build the orchestrator factory for a registered provider when classes exist.
 * @param adapterId - Runtime adapter UUID
 * @param adapterName - Stable adapter name
 * @param logImportConfig - Optional per-adapter log import configuration
 * @param LogOrchestratorClass - Import-mode orchestrator class, when supported
 * @param LogDiscoveryOrchestratorClass - Discovery-mode orchestrator class, when supported
 * @param machineId - Machine identifier forwarded from the product descriptor
 * @returns Orchestrator factory, or null when the provider has no orchestrators
 */
export function buildOrchestratorFactory(
  adapterId: string,
  adapterName: string,
  logImportConfig: LogImportConfig | undefined,
  LogOrchestratorClass: LogOrchestratorConstructor | undefined,
  LogDiscoveryOrchestratorClass: LogOrchestratorConstructor | undefined,
  machineId?: string | null,
): OrchestratorFactory | null {
  if (!LogOrchestratorClass && !LogDiscoveryOrchestratorClass) {
    return null;
  }

  const config = buildOrchestratorConfig(adapterId, adapterName, logImportConfig, machineId);

  return (mode: Exclude<LogImportMode, 'disabled'>): LogImportOrchestrator | null => {
    if (!config.enabled) {
      return null;
    }

    if (mode === 'discover' && LogDiscoveryOrchestratorClass) {
      return new LogDiscoveryOrchestratorClass(config);
    }
    if (mode === 'import' && LogOrchestratorClass) {
      return new LogOrchestratorClass(config);
    }

    return null;
  };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

/**
 * Restore persisted global mode for a newly registered importer.
 *
 * If no mode handler is present (not handled), or if the persisted mode is
 * `'disabled'`, no orchestrator is started. Errors from the mode query are
 * caught and logged so they don't abort provider registration.
 * @param importerId - Runtime importer ID
 * @param adapterName - Stable adapter name used for the mode lookup
 * @param bus - Message bus instance
 * @param switchMode - Bound `switchMode` from the registry
 */
async function restorePersistedMode(
  importerId: string,
  adapterName: string,
  bus: IMakaioBus,
  switchMode: (id: string, mode: LogImportMode) => Promise<void>,
): Promise<void> {
  try {
    const modeResult = await bus.requestOptional(LogImportSubjects.getMode, {
      adapterName,
    });
    if (!modeResult.handled) {
      return;
    }
    const { mode } = modeResult.data;

    if (mode === 'disabled') {
      return;
    }

    await switchMode(importerId, mode);
  } catch (error) {
    console.warn(`[LogImport] Failed to restore persisted mode for '${adapterName}':`, error);
  }
}

/**
 * Register an importer and orchestrator factory from a capability provider payload.
 *
 * Skips registration silently when the payload is not a valid log-import
 * provider or when the importer is already registered (idempotent).
 * @param providerValue - Runtime capability provider payload (opaque `unknown`)
 * @param bus - Message bus instance
 * @param registrar - Registry operations required to complete the registration
 */
export async function registerFromProvider(
  providerValue: unknown,
  bus: IMakaioBus,
  registrar: CapabilityProviderRegistrar,
): Promise<void> {
  if (!isLogImportProvider(providerValue) || registrar.getImporter(providerValue.id) !== undefined) {
    return;
  }

  await registrar.register({
    id: providerValue.id,
    adapterName: providerValue.adapterName,
    displayName: providerValue.displayName,
    source: classifyLogImporterSource({ hasAdapterContribution: true }),
    importer: new providerValue.registration.LogImporterClass({
      adapterId: providerValue.id,
      adapterName: providerValue.adapterName,
    }),
    logFilePattern: providerValue.registration.logFilePattern,
    clientId: providerValue.registration.clientId,
    machineId: providerValue.machineId,
  });

  const factory = buildOrchestratorFactory(
    providerValue.id,
    providerValue.adapterName,
    providerValue.logImportConfig,
    providerValue.registration.LogOrchestratorClass,
    providerValue.registration.LogDiscoveryOrchestratorClass,
    providerValue.machineId,
  );
  if (factory) {
    registrar.setOrchestratorFactory(providerValue.id, factory);
  }

  await restorePersistedMode(providerValue.id, providerValue.adapterName, bus, (id, mode) =>
    registrar.switchMode(id, mode),
  );
}

// ---------------------------------------------------------------------------
// Subscription setup
// ---------------------------------------------------------------------------

/**
 * Register the capability-subscription listener and backfill existing providers.
 *
 * Must be called **after** the bus listener is set up to avoid a drop window:
 * the live subscription is attached first, then the backfill runs so that any
 * providers registered between the two steps are not lost.
 * @param bus - Message bus instance
 * @param capabilityService - Optional service used to enumerate pre-registered providers
 * @param registrar - Registry operations required to complete each registration
 * @returns Cleanup function that removes the bus subscription
 */
export async function registerCapabilitySubscription(
  bus: IMakaioBus,
  capabilityService: CapabilityService | undefined,
  registrar: CapabilityProviderRegistrar,
): Promise<() => void> {
  const cleanup = bus.on(
    CapabilitySubjects.register,
    async (ctx) => {
      await registerFromProvider(ctx.payload.provider, bus, registrar);
    },
    { filter: { capabilityId: 'log-import' } },
  );

  // Subscribe first, then backfill. This avoids a drop window between
  // enumerating existing providers and attaching the live listener.
  for (const provider of capabilityService?.getProviders('log-import') ?? []) {
    await registerFromProvider(provider, bus, registrar);
  }

  return cleanup;
}

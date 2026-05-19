import type { IMakaioBus } from '@makaio/bus-core';
/**
 * Contribution processor for `MakaioNodeExtension<IMakaioBus>.logImport` surfaces.
 *
 * Wires package-declared log importers into {@link LogImportRegistry} during
 * extension activation and tears them down during shutdown or disable.
 * @packageDocumentation
 */

import type { ExtensionContext, MakaioNodeExtension } from '@makaio/contracts';
import type { LogImportConfig, LogImportOrchestrator, LogOrchestratorConfig } from '@makaio/ai-adapters-core';
import type { ContributionProcessor } from '@makaio/kernel';
import type { OrchestratorFactory } from './types.js';
import { LogImportRegistryToken } from './package.js';
import { classifyLogImporterSource } from './log-import-source.js';

/**
 * Narrowed shape of the `logImport.config` field on a `MakaioNodeExtension<IMakaioBus>`.
 *
 * {@link MakaioNodeExtension.logImport} keeps `config` as `unknown` to avoid a
 * contracts-layer dependency on `@makaio/ai-adapters-core`. This processor-
 * local interface describes the actual shape expected at wiring time, mirroring
 * `LogImportRegistration` from `@makaio/ai-adapters-core`.
 */
interface LogImportContributionConfig {
  /** Importer class constructor. */
  readonly LogImporterClass: new (opts: {
    adapterId: string;
    adapterName: string;
  }) => unknown;
  /** Full-import orchestrator class constructor, if supported. */
  readonly LogOrchestratorClass?: new (
    opts: LogOrchestratorConfig,
  ) => LogImportOrchestrator;
  /** Discovery-mode orchestrator class constructor, if supported. */
  readonly LogDiscoveryOrchestratorClass?: new (
    opts: LogOrchestratorConfig,
  ) => LogImportOrchestrator;
  /** Glob pattern for matching log files. */
  readonly logFilePattern?: string;
  /** Optional runtime log-import configuration for orchestrator setup. */
  readonly logImportConfig?: LogImportConfig;
  /** Whether manual scan/import operations are supported. */
  readonly supportsManualImport?: boolean;
}

/**
 * Build the orchestrator config for a package-contributed importer.
 * @param importerId - Unique registry ID for this importer.
 * @param adapterName - Stable adapter name for the orchestrator config.
 * @param logImportConfig - Optional runtime log-import configuration.
 * @returns Normalized orchestrator configuration.
 */
function buildOrchestratorConfig(
  importerId: string,
  adapterName: string,
  logImportConfig?: LogImportConfig,
): LogOrchestratorConfig {
  return {
    enabled: logImportConfig?.enabled ?? true,
    pollIntervalMs: logImportConfig?.pollIntervalMs,
    eventsPerSecond: logImportConfig?.eventsPerSecond,
    adapterId: importerId,
    adapterName,
    checkMakaioManaged: logImportConfig?.checkMakaioManaged,
  };
}

/**
 * Build an orchestrator factory for a package-contributed log importer.
 *
 * Returns `null` when neither orchestrator class is declared — in that case
 * the registry manages the importer without orchestrator lifecycle support.
 * @param importerId - Unique registry ID for this importer.
 * @param adapterName - Stable adapter name for the orchestrator config.
 * @param config - Narrowed log import config from the extension's `logImport.config`.
 * @returns Mode-dispatching factory, or `null` when no orchestrator is available.
 */
function buildOrchestratorFactory(
  importerId: string,
  adapterName: string,
  config: LogImportContributionConfig,
): OrchestratorFactory | null {
  if (!config.LogOrchestratorClass && !config.LogDiscoveryOrchestratorClass) {
    return null;
  }
  const orchestratorConfig = buildOrchestratorConfig(importerId, adapterName, config.logImportConfig);
  return (mode) => {
    if (!orchestratorConfig.enabled) {
      return null;
    }
    if (mode === 'discover' && config.LogDiscoveryOrchestratorClass) {
      return new config.LogDiscoveryOrchestratorClass(orchestratorConfig);
    }
    if (mode === 'import' && config.LogOrchestratorClass) {
      return new config.LogOrchestratorClass(orchestratorConfig);
    }
    return null;
  };
}

/**
 * Create a {@link ContributionProcessor} that wires `MakaioNodeExtension<IMakaioBus>.logImport`
 * surfaces into the {@link LogImportRegistry}.
 *
 * The returned processor:
 * - Filters to extensions that declare `logImport`.
 * - On activation: resolves `LogImportRegistry` from the extension context,
 *   registers the log importer, and attaches an orchestrator factory when the
 *   config provides orchestrator classes.
 * - On stopped: unregisters the importer and calls any registered cleanup.
 *
 * **Error semantics:** `processActivated` throws a hard error when
 * `LogImportRegistry` is missing (composition misconfiguration) or when
 * registration fails. Any partial state is rolled back before re-throwing.
 * `processStopped` is best-effort and must not throw.
 * @returns A `ContributionProcessor` ready for registration with the coordinator.
 */
export function createLogImportContributionProcessor(): ContributionProcessor {
  const cleanups = new Map<string, () => Promise<void>>();

  return {
    filter: (pkg: MakaioNodeExtension<IMakaioBus>): boolean => !!pkg.logImport,

    processActivated: async (
      name: string,
      pkg: MakaioNodeExtension<IMakaioBus>,
      ctx: ExtensionContext,
    ): Promise<void> => {
      const { logImport } = pkg;
      if (!logImport) return;

      const registry = ctx.getService(LogImportRegistryToken);
      if (!registry) {
        throw new Error(
          `[LogImportContributionProcessor] LogImportRegistry is not available. ` +
            `Ensure '${LogImportRegistryToken.name}' is listed as a dependency before activating '${name}'.`,
        );
      }

      const { adapterName, displayName, config } = logImport;
      const contributionConfig = config as LogImportContributionConfig;
      const importerId = `package:${name}`;
      const source = classifyLogImporterSource({ hasAdapterContribution: !!pkg.adapters?.length });

      const importer = new contributionConfig.LogImporterClass({ adapterId: importerId, adapterName });

      await registry.register({
        id: importerId,
        adapterName,
        displayName,
        source,
        importer: importer as Parameters<typeof registry.register>[0]['importer'],
        logFilePattern: contributionConfig.logFilePattern ?? '',
        supportsManualImport: contributionConfig.supportsManualImport,
      });

      try {
        const factory = buildOrchestratorFactory(importerId, adapterName, contributionConfig);
        if (factory) {
          registry.setOrchestratorFactory(importerId, factory);
        }
      } catch (err) {
        // Orchestrator wiring failed — roll back the registration.
        try {
          await registry.unregister(importerId);
        } catch (rollbackErr) {
          console.error(
            `[LogImportContributionProcessor] Rollback of log importer '${importerId}' failed:`,
            rollbackErr,
          );
        }
        throw err;
      }

      console.info(`[LogImportContributionProcessor] Registered log importer '${adapterName}' from package: ${name}`);

      cleanups.set(importerId, async () => {
        try {
          await registry.unregister(importerId);
        } catch (err) {
          console.error(
            `[LogImportContributionProcessor] Failed to unregister log importer '${importerId}' during cleanup:`,
            err,
          );
        }
      });
    },

    processStopped: async (name: string): Promise<void> => {
      const importerId = `package:${name}`;
      const cleanup = cleanups.get(importerId);
      if (!cleanup) return;
      cleanups.delete(importerId);
      await cleanup();
    },
  };
}

/**
 * Shared helper for constructing orchestrator configurations.
 *
 * Both the contribution-processor and the capability-provider need to build
 * identical `LogOrchestratorConfig` objects from adapter metadata. This
 * module is the single source of truth for that construction.
 * @packageDocumentation
 */

import type { LogImportConfig, LogOrchestratorConfig } from '@makaio/ai-adapters-core';

/** Named inputs for {@link buildOrchestratorConfig}. */
export interface OrchestratorConfigInput {
  /** Runtime adapter UUID or registry ID. */
  adapterId: string;
  /** Stable adapter name. */
  adapterName: string;
  /** Optional per-adapter log import configuration. */
  logImportConfig?: LogImportConfig;
  /** Machine identifier forwarded from the product descriptor. */
  machineId?: string | null;
  /** Stable client id for runtime-truth skip detection. */
  clientId?: string;
}

/**
 * Build a normalized orchestrator config from adapter runtime metadata.
 *
 * The returned config preserves the adapter-level enable flag so persisted
 * modes cannot restart an importer that runtime config disabled.
 * @param input - Named adapter metadata (see {@link OrchestratorConfigInput})
 * @returns Normalized orchestrator configuration
 */
export function buildOrchestratorConfig(input: OrchestratorConfigInput): LogOrchestratorConfig {
  const { adapterId, adapterName, logImportConfig, machineId, clientId } = input;
  return {
    enabled: logImportConfig?.enabled ?? true,
    pollIntervalMs: logImportConfig?.pollIntervalMs,
    eventsPerSecond: logImportConfig?.eventsPerSecond,
    adapterId,
    adapterName,
    checkMakaioManaged: logImportConfig?.checkMakaioManaged,
    clientId,
    machineId,
  };
}

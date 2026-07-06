/**
 * Types for the LogImportRegistry service.
 * @packageDocumentation
 */

import type { LogImporter, LogImportOrchestrator } from '@makaio/ai-adapters-core';
import type { LogImportMode } from './schemas/index.js';
import type { CapabilityService } from '@makaio/services-core/capability';

/**
 * Factory function that creates a {@link LogImportOrchestrator} for a given mode.
 *
 * Returns `null` when no orchestrator is available for the requested mode
 * (e.g., discovery requested but no `LogDiscoveryOrchestratorClass` was
 * registered for this adapter).
 * @param mode - Target import mode (never `'disabled'`)
 * @returns Orchestrator instance or null if the mode requires no orchestrator
 */
export type OrchestratorFactory = (mode: Exclude<LogImportMode, 'disabled'>) => LogImportOrchestrator | null;

/**
 * Public provenance class for a registered log importer.
 */
export type LogImporterSource = 'adapter' | 'extension';

/**
 * Registration entry for a log importer.
 *
 * Stores metadata and references needed to manage the importer lifecycle.
 */
export interface LogImporterRegistration {
  /**
   * Unique ID: adapterId for adapters, `package:{name}` for extensions.
   */
  id: string;

  /**
   * Adapter name used for session lookup and provenance tracking.
   * @example 'claude-code-cli', 'codex-app-server', 'github-copilot-sdk'
   */
  adapterName: string;

  /**
   * Human-readable name.
   * @example 'Claude Code', 'GitHub Copilot SDK'
   */
  displayName: string;

  /**
   * Source type.
   */
  source: LogImporterSource;

  /**
   * Importer instance.
   */
  importer: LogImporter<unknown, unknown>;

  /**
   * Glob pattern for log files.
   * @example '**\/session.jsonl'
   */
  logFilePattern: string;

  /**
   * Whether this importer supports manual scan/import operations.
   * Defaults to true.
   */
  supportsManualImport?: boolean;

  /**
   * Stable client application id (e.g., `'claude-code'`) whose native hooks
   * observe the sessions this importer ingests.
   *
   * Enables client-agnostic framework components to resolve the importer for
   * a `client.session.*` event without hard-coding importer names. Any string
   * is valid — framework logic never hard-codes specific client ids.
   */
  clientId?: string;

  /**
   * Factory for creating orchestrators for this importer.
   *
   * When present, the registry can swap orchestrators on mode change via
   * {@link LogImportRegistry.switchMode}. Absent when neither
   * `LogOrchestratorClass` nor `LogDiscoveryOrchestratorClass` was provided.
   */
  orchestratorFactory?: OrchestratorFactory;
}

/**
 * Configuration options for LogImportRegistry.
 */
export interface LogImportRegistryOptions {
  /**
   * Message bus instance (defaults to MakaioBus).
   */
  bus?: import('@makaio/bus-core').IMakaioBus;
  /**
   * Capability service used to backfill providers registered before init().
   */
  capabilityService?: CapabilityService;
}

/**
 * Service instance returned by the log-import composition factory.
 *
 * Bundles the {@link LogImportRegistry} and the session-import handler
 * cleanup so both are torn down together on shutdown.
 */
export interface LogImportServiceInstance {
  /** The live log-import registry. */
  readonly registry: import('./log-import-registry.js').LogImportRegistry;
  /** Tears down the registry and all session-import handlers. */
  destroy(): Promise<void>;
}

/**
 * Internal storage for orchestrator instances.
 */
export interface OrchestratorEntry {
  /**
   * Orchestrator instance.
   */
  orchestrator: LogImportOrchestrator;

  /**
   * Whether orchestrator was started by registry.
   */
  isManaged: boolean;
}

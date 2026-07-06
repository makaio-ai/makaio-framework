import type { LogImporter, LogImporterConfig } from './types.js';
import type { LogOrchestratorConfig } from './base-orchestrator.js';

/**
 * Configuration for log import behavior.
 *
 * Shared between runtime config and orchestrator setup.
 */
export interface LogImportConfig {
  /** Whether log import is enabled. */
  enabled: boolean;
  /** Polling interval for the file watcher in milliseconds. */
  pollIntervalMs?: number;
  /** Maximum events to emit per second (rate limiting). */
  eventsPerSecond?: number;
  /** Function to check if a session is managed by Makaio (to skip already tracked sessions). */
  checkMakaioManaged?: (sessionId: string) => Promise<boolean>;
}

/**
 * Minimal interface for log import orchestrators.
 *
 * Allows LogImportRegistry to manage lifecycle without coupling
 * to a specific orchestrator implementation.
 */
export interface LogImportOrchestrator {
  /** Whether the orchestrator is running. */
  isRunning(): boolean;
  /** Start the orchestrator. */
  start(): Promise<void>;
  /** Stop the orchestrator. */
  stop(): void | Promise<void>;
  /** Dispose of any resources. */
  dispose(): void | Promise<void>;
}

/** Shared constructor signature for log import orchestrator classes. */
export type LogOrchestratorConstructor = new (config: LogOrchestratorConfig) => LogImportOrchestrator;

/** Shared constructor signature for log importer classes. */
export type LogImporterConstructor = new (config: LogImporterConfig) => LogImporter<unknown, unknown>;

/**
 * Registration metadata for log importers.
 *
 * Used by runtimes to wire importers into the LogImportRegistry.
 * The adapter name is provided by the runtime at registration time via `adapter.name`.
 */
export interface LogImportRegistration {
  /** Human-readable name. */
  displayName: string;
  /** Log importer class constructor. */
  LogImporterClass: LogImporterConstructor;
  /** Optional orchestrator class for full session import mode. */
  LogOrchestratorClass?: LogOrchestratorConstructor;
  /**
   * Optional orchestrator class for shallow discovery mode.
   *
   * When present, the runtime uses this class instead of {@link LogOrchestratorClass}
   * when the adapter's import mode is set to `'discover'`.
   */
  LogDiscoveryOrchestratorClass?: LogOrchestratorConstructor;
  /** Glob pattern for log files. */
  logFilePattern: string;
  /**
   * Stable client application id (e.g., `'claude-code'`) whose native hooks
   * observe the sessions this importer ingests.
   *
   * Enables client-agnostic framework components to resolve the importer for
   * a `client.session.*` event without hard-coding importer names. Any string
   * is valid — framework logic never hard-codes specific client ids.
   */
  clientId?: string;
}

/**
 * Central registry for log importers (adapters and extensions).
 *
 * Manages registration, lifecycle, and query operations for log importers.
 * Orchestrators are created lazily when started and settings-driven.
 * @packageDocumentation
 */

import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import type { LogImportOrchestrator } from '@makaio/ai-adapters-core';
import { LogImportSubjects } from './namespace.js';
import type { LogImportMode, LogImporterInfo } from './schemas/index.js';
import type { JsonObject } from 'type-fest';

import type {
  LogImporterRegistration,
  LogImportRegistryOptions,
  OrchestratorEntry,
  OrchestratorFactory,
} from './types.js';
import { registerGenericScanHandler } from './generic-import-handlers.js';
import { registerGenericUploadFilesHandler } from './upload-handler.js';
import { registerImportSessionHandler } from './import-session-handler.js';
import { registerImportFileHandler } from './import-file-handler.js';
import { registerCapabilitySubscription, type CapabilityProviderRegistrar } from './capability-provider.js';
import { stopAndDisposeOrchestrator, startOrchestratorOrCleanup } from './orchestrator-lifecycle.js';

/**
 * Registry for managing log importers and their orchestrator lifecycle.
 *
 * Follows the ToolRegistry pattern with key differences:
 * - Manages orchestrators instead of toolsets
 * - Lazy orchestrator creation (only when started)
 * - Auto-detection via detectImporter()
 * @example
 * ```typescript
 * const registry = new LogImportRegistry();
 * await registry.init();
 *
 * // Register an importer
 * await registry.register({
 *   id: 'claude-code-1',
 *   adapterName: 'claude-code-cli',
 *   displayName: 'Claude Code',
 *   source: 'adapter',
 *   importer: myImporter,
 *   logFilePattern: '**\/session.jsonl',
 * });
 *
 * // Start watching for new sessions
 * await registry.startImporter('claude-code-1');
 * ```
 */
export class LogImportRegistry implements CapabilityProviderRegistrar {
  private readonly bus: IMakaioBus;
  private readonly capabilityService?: import('@makaio/services-core/capability').CapabilityService;
  private readonly registrations = new Map<string, LogImporterRegistration>();
  private readonly orchestrators = new Map<string, OrchestratorEntry>();
  private readonly cleanupHandlers: Array<() => void> = [];
  private initialized = false;

  /**
   * Creates a new LogImportRegistry instance.
   * @param options - Optional configuration
   */
  public constructor(options?: LogImportRegistryOptions) {
    this.bus = options?.bus ?? MakaioBus;
    this.capabilityService = options?.capabilityService;
  }

  /**
   * Initializes the registry and registers bus handlers.
   *
   * Registers handlers for:
   * - listImporters: List all registered importers
   * - scan: Scan log directory for sessions (generic handler)
   * - uploadFiles: Process uploaded files (generic handler)
   * - importSession: Lazy-load pick-up for discovered sessions
   * - importFile: File-path-addressable import trigger (graceful-absence contract)
   * - capability register: Auto-register adapters that publish log-import capabilities
   *
   * Must be called before using the registry.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    const listCleanup = this.bus.on(LogImportSubjects.listImporters, (ctx) => {
      const importers = this.listImporters();
      ctx.setResult({ importers });
    });
    this.cleanupHandlers.push(listCleanup);

    const scanCleanup = registerGenericScanHandler(this.bus, (adapterName) =>
      this.getImporterByAdapterName(adapterName),
    );
    this.cleanupHandlers.push(scanCleanup);

    const uploadCleanup = registerGenericUploadFilesHandler(this.bus, (adapterName) =>
      this.getImporterByAdapterName(adapterName),
    );
    this.cleanupHandlers.push(uploadCleanup);

    const importSessionCleanup = registerImportSessionHandler(this.bus, (adapterName) =>
      this.getImporterByAdapterName(adapterName),
    );
    this.cleanupHandlers.push(importSessionCleanup);

    const importFileCleanup = registerImportFileHandler(this.bus, (adapterName) =>
      this.getImporterByAdapterName(adapterName),
    );
    this.cleanupHandlers.push(importFileCleanup);

    const capabilityCleanup = await registerCapabilitySubscription(this.bus, this.capabilityService, this);
    this.cleanupHandlers.push(capabilityCleanup);

    this.initialized = true;
  }

  /**
   * Registers a log importer.
   *
   * Does not start the orchestrator automatically. Use startImporter() to begin watching.
   * @param registration - Importer registration data
   * @throws If an importer with the same ID is already registered
   */
  public async register(registration: LogImporterRegistration): Promise<void> {
    if (this.registrations.has(registration.id)) {
      throw new Error(`Log importer '${registration.id}' is already registered`);
    }

    this.registrations.set(registration.id, registration);
  }

  /**
   * Unregisters a log importer.
   *
   * Stops the orchestrator if running, disposes it, and removes all references.
   * @param importerId - Unique importer ID
   * @throws If the importer is not registered
   */
  public async unregister(importerId: string): Promise<void> {
    if (!this.registrations.has(importerId)) {
      throw new Error(`Log importer '${importerId}' is not registered`);
    }

    await stopAndDisposeOrchestrator(this.orchestrators, importerId);

    this.registrations.delete(importerId);
  }

  /**
   * Starts the orchestrator for a registered importer.
   *
   * Creates the orchestrator if not already created (lazy initialization).
   * Note: Orchestrator creation requires adapter-specific factory logic,
   * which is handled externally. This method manages the lifecycle only.
   * @param importerId - Unique importer ID
   * @throws If the importer is not registered or orchestrator is not provided
   */
  public async startImporter(importerId: string): Promise<void> {
    const registration = this.registrations.get(importerId);
    if (!registration) {
      throw new Error(`Log importer '${importerId}' is not registered`);
    }

    const entry = this.orchestrators.get(importerId);
    if (!entry) {
      throw new Error(
        `No orchestrator available for '${importerId}'. ` +
          `Orchestrators must be created and provided by the adapter or extension before starting.`,
      );
    }

    if (entry.orchestrator.isRunning()) {
      return; // Already running
    }

    await entry.orchestrator.start();
    entry.isManaged = true;
  }

  /**
   * Stops the orchestrator for a registered importer.
   *
   * Does nothing if the orchestrator is not running.
   * @param importerId - Unique importer ID
   */
  public async stopImporter(importerId: string): Promise<void> {
    const entry = this.orchestrators.get(importerId);
    if (!entry) {
      return; // No orchestrator to stop
    }

    if (entry.orchestrator.isRunning()) {
      await entry.orchestrator.stop();
    }
    entry.isManaged = false;
  }

  /**
   * Switches the orchestrator mode for a registered importer.
   *
   * Stops the current orchestrator (if running), disposes it, creates a new
   * orchestrator for the requested mode via the registration's factory, and
   * starts it. When `mode` is `'disabled'`, any running orchestrator is stopped
   * and cleared without starting a replacement.
   *
   * No-op when the importer has no `orchestratorFactory` (no orchestrator
   * classes were provided at registration time).
   * @param importerId - Unique importer ID
   * @param mode - Target import mode
   * @throws If the importer is not registered
   */
  public async switchMode(importerId: string, mode: LogImportMode): Promise<void> {
    const registration = this.registrations.get(importerId);
    if (!registration) {
      throw new Error(`Log importer '${importerId}' is not registered`);
    }

    // Stop and dispose the current orchestrator regardless of new mode
    await stopAndDisposeOrchestrator(this.orchestrators, importerId);

    if (mode === 'disabled') {
      return; // Nothing to start
    }

    if (!registration.orchestratorFactory) {
      return; // No factory — orchestrator management not supported for this importer
    }

    const orchestrator = registration.orchestratorFactory(mode);
    if (!orchestrator) {
      return; // Factory returned null for this mode (e.g., no discovery class available)
    }

    await startOrchestratorOrCleanup(orchestrator, importerId);

    this.orchestrators.set(importerId, {
      orchestrator,
      isManaged: true,
    });
  }

  /**
   * Convenience method that starts discovery mode for a registered importer.
   *
   * Equivalent to calling `switchMode(id, 'discover')`. Provided as a
   * named shorthand so call sites read as intent rather than mechanism.
   * @param importerId - Unique importer ID
   * @returns Promise that resolves when the discovery orchestrator has started
   * @throws If the importer is not registered
   */
  public async startDiscovery(importerId: string): Promise<void> {
    return this.switchMode(importerId, 'discover');
  }

  /**
   * Attaches an orchestrator factory to a registered importer.
   *
   * Called by the runtime after creating orchestrator class instances so the
   * registry can reconstruct orchestrators when the mode changes via
   * {@link switchMode}.
   * @param importerId - Unique importer ID
   * @param factory - Factory function that produces orchestrators for a given mode
   * @throws If the importer is not registered
   */
  public setOrchestratorFactory(importerId: string, factory: OrchestratorFactory): void {
    const registration = this.registrations.get(importerId);
    if (!registration) {
      throw new Error(`Cannot set orchestrator factory for unregistered importer '${importerId}'`);
    }

    this.registrations.set(importerId, { ...registration, orchestratorFactory: factory });
  }

  /**
   * Lists all registered importers with their current status.
   * @returns Array of importer information
   */
  public listImporters(): LogImporterInfo[] {
    const importers: LogImporterInfo[] = [];

    for (const [, registration] of this.registrations) {
      const entry = this.orchestrators.get(registration.id);
      const isRunning = entry?.orchestrator.isRunning() ?? false;

      importers.push({
        id: registration.id,
        adapterName: registration.adapterName,
        displayName: registration.displayName,
        source: registration.source,
        logFilePattern: registration.logFilePattern,
        isRunning,
        supportsManualImport: registration.supportsManualImport ?? true,
        ...(registration.clientId !== undefined && { clientId: registration.clientId }),
      });
    }

    return importers;
  }

  /**
   * Gets a registered importer by ID.
   * @param importerId - Unique importer ID
   * @returns Importer registration or undefined if not found
   */
  public getImporter(importerId: string): LogImporterRegistration | undefined {
    const registration = this.registrations.get(importerId);
    return registration ? { ...registration } : undefined;
  }

  /**
   * Gets a registered importer by adapter name.
   * @param adapterName - Adapter name (e.g., 'claude-code-cli', 'codex-app-server')
   * @returns Importer registration or undefined if not found
   */
  public getImporterByAdapterName(adapterName: string): LogImporterRegistration | undefined {
    for (const registration of this.registrations.values()) {
      if (registration.adapterName === adapterName) {
        return { ...registration };
      }
    }
    return undefined;
  }

  /**
   * Auto-detects which importer can handle a log sample.
   *
   * Used during log upload to match unknown formats with compatible importers.
   * @param sample - Sample log content (string or parsed JSON object)
   * @returns Matching importer registration or undefined if no match
   */
  public detectImporter(sample: string | JsonObject): LogImporterRegistration | undefined {
    let bestMatch: LogImporterRegistration | undefined;
    let bestConfidence = 0;

    for (const registration of this.registrations.values()) {
      const result = registration.importer.canHandle(sample);

      if (result === false) {
        continue;
      }

      // Handle boolean true (treat as 100% confidence)
      const confidence = result === true ? 1.0 : result.confidence;

      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = registration;
      }
    }

    return bestMatch;
  }

  /**
   * Registers an orchestrator for a specific importer.
   *
   * This is called by adapters/extensions after they create their orchestrator instance.
   * The registry manages the lifecycle but doesn't create orchestrators itself.
   * @param importerId - Unique importer ID
   * @param orchestrator - Orchestrator instance
   * @throws If the importer is not registered
   */
  public async registerOrchestrator(importerId: string, orchestrator: LogImportOrchestrator): Promise<void> {
    if (!this.registrations.has(importerId)) {
      throw new Error(`Cannot register orchestrator for unregistered importer '${importerId}'`);
    }

    // Dispose existing orchestrator if present (prevents leak on re-registration)
    await stopAndDisposeOrchestrator(this.orchestrators, importerId);

    this.orchestrators.set(importerId, {
      orchestrator,
      isManaged: false,
    });
  }

  /**
   * Cleans up registry resources.
   *
   * Stops all running orchestrators and unsubscribes from bus handlers.
   */
  public async destroy(): Promise<void> {
    if (!this.initialized && this.orchestrators.size === 0 && this.cleanupHandlers.length === 0) {
      return;
    }

    // Safe: stopAndDisposeOrchestrator deletes the current key (importerId)
    // from the map. Deleting an already-visited Map entry during for...of is
    // spec-safe; only deleting a not-yet-visited key would cause skipping.
    for (const [importerId] of this.orchestrators) {
      await stopAndDisposeOrchestrator(this.orchestrators, importerId);
    }

    // Clean up bus handlers
    for (const cleanup of this.cleanupHandlers) {
      cleanup();
    }
    this.cleanupHandlers.length = 0;

    this.initialized = false;
  }
}

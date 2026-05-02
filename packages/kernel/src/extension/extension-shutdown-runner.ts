import { runContributionProcessors } from './contribution-processor-runner.js';
import type { ExtensionContextHost } from './extension-context-builder.js';
import { transitionPackageEntry } from './state-transition.js';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

/** Coordinator state required to shut down active extensions. */
export interface ExtensionShutdownHost {
  /** Loaded extension entries keyed by extension name. */
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  /** Dependency-sorted extension names from boot-time load. */
  readonly loadOrder: readonly string[];
  /** Awaited contribution processors registered with the coordinator. */
  readonly contributionProcessors: readonly ContributionProcessor[];
  /** Context host used by contribution processors during deactivation. */
  readonly contextHost: ExtensionContextHost;
}

/**
 * Shut down active extensions in reverse dependency order.
 *
 * Contribution processors are stopped before services and storage handlers are
 * destroyed so extension-owned services remain available while contributions
 * unregister. Services are then destroyed before storage handlers are removed,
 * allowing destroy hooks to flush through registered storage seams.
 * @param host - Coordinator state required to shut down extensions.
 */
export async function shutdownExtensions(host: ExtensionShutdownHost): Promise<void> {
  const reversed = [...host.loadOrder].reverse();

  for (const name of reversed) {
    const entry = host.entries.get(name);
    if (!entry) continue;

    if (entry.state === 'active') {
      await runContributionProcessors(host.contributionProcessors, host.contextHost, name, entry, 'stopped');
    }

    if (entry.service) {
      try {
        await entry.service.destroy?.();
      } catch (err) {
        console.error(`[ExtensionCoordinator] Error during shutdown of "${name}":`, err);
      } finally {
        entry.service = undefined;
      }
    }

    if (entry.storageCleanup) {
      try {
        entry.storageCleanup();
      } catch (err) {
        console.error(`[ExtensionCoordinator] Storage cleanup error for "${name}":`, err);
      } finally {
        entry.storageCleanup = undefined;
      }
    }

    if (entry.state === 'active') {
      transitionPackageEntry(host.contextHost.bus, entry, 'stopped');
    }
  }
}

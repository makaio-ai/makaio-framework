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
 *
 * A teardown failure never stops the run: every remaining extension is still
 * shut down. It is also never swallowed. All failures are reported together
 * once the last extension has been stopped, so the host that owns process
 * termination learns that the drain was incomplete instead of being told it
 * finished.
 * @param host - Coordinator state required to shut down extensions.
 * @throws An AggregateError when any contribution stop, service destroy, or storage cleanup failed.
 */
export async function shutdownExtensions(host: ExtensionShutdownHost): Promise<void> {
  const reversed = [...host.loadOrder].reverse();
  const failures: unknown[] = [];
  const unclean: string[] = [];

  for (const name of reversed) {
    const entry = host.entries.get(name);
    if (!entry) continue;

    let entryFailed = false;
    if (entry.state === 'active') {
      const contributionFailures = await runContributionProcessors(
        host.contributionProcessors,
        host.contextHost,
        name,
        entry,
        'stopped',
      );
      if (contributionFailures.length > 0) {
        entryFailed = true;
        failures.push(...contributionFailures);
      }
    }

    if (entry.service) {
      try {
        await entry.service.destroy?.();
      } catch (err) {
        entryFailed = true;
        failures.push(err);
      } finally {
        entry.service = undefined;
      }
    }

    if (entry.storageCleanup) {
      try {
        entry.storageCleanup();
      } catch (err) {
        entryFailed = true;
        failures.push(err);
      } finally {
        entry.storageCleanup = undefined;
      }
    }

    if (entryFailed) unclean.push(name);

    if (entry.state === 'active') {
      transitionPackageEntry(host.contextHost.bus, entry, 'stopped');
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Extensions failed to shut down cleanly: ${unclean.join(', ')}`);
  }
}

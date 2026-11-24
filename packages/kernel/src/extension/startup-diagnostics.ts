import type { CallContext } from '@makaio/core';
import { runExtensionHealthCheck, type ExtensionHealthHost } from './extension-health-runner.js';
import { emitWarnings, type EmitterHost } from './health-warning-emitter.js';
import type { OpenContributionIndex } from './open-contribution-index.js';

/** Coordinator state needed to report diagnostics after startup. */
interface StartupDiagnosticsHost extends ExtensionHealthHost {
  /** Loaded extensions in dependency order, with their display names for warnings. */
  readonly entries: ExtensionHealthHost['entries'] & EmitterHost['entries'];
  /** Warning action lookup populated while publishing startup toasts. */
  readonly warningActionMap: EmitterHost['warningActionMap'];
  /** Live contribution index used to find kinds without an active owner. */
  readonly openContributions: Pick<OpenContributionIndex, 'unclaimedKinds'>;
}

/**
 * Check active extension health, publish warnings, and report unclaimed contribution kinds.
 * @param call - Host startup call responsible for warning publication.
 * @param host - Coordinator state needed for diagnostics.
 */
export async function reportStartupDiagnostics(call: CallContext, host: StartupDiagnosticsHost): Promise<void> {
  const activeNames = [...host.entries].filter(([, entry]) => entry.state === 'active').map(([name]) => name);
  await Promise.all(activeNames.map((name) => runExtensionHealthCheck(host, name)));
  await emitWarnings(call, host);

  // Health warnings belong to an extension entry; an unclaimed kind has no owner entry to attach to.
  for (const kind of host.openContributions.unclaimedKinds(activeNames)) {
    console.warn(
      '[ExtensionCoordinator] Open contribution kind "%s" has entries but no active extension owns it',
      kind,
    );
  }
}

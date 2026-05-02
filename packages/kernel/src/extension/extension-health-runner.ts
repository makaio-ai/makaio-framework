import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionServiceLifecycle, ExtensionWarning } from '@makaio/contracts';
import { ExtensionWarningSchema } from '@makaio/contracts/extension';
import { ExtensionSubjects } from '../observability/extension-namespace.js';
import type { ExtensionEntry } from './types.js';

/** Coordinator state required to run extension health checks. */
export interface ExtensionHealthHost {
  /** Bus used to emit warning snapshots. */
  readonly bus: IMakaioBus;
  /** Loaded extension entries keyed by extension name. */
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
}

/**
 * Run the `checkHealth` hook for a single active extension and store results.
 *
 * Returns early without emitting when the extension has no service, is not
 * active, or does not implement `checkHealth`. The return value is validated
 * against {@link ExtensionWarningSchema} via `safeParse`; malformed payloads
 * are logged and treated as empty. Any exception thrown by `checkHealth` is
 * caught and logged so a misbehaving health check cannot destabilize startup.
 *
 * Emits `kernel:extension.warnings.changed` after every run so subscribers receive a
 * fresh snapshot even when the warning set is unchanged.
 * @param host - Coordinator state required by the health runner.
 * @param name - Extension name used for lookup and bus emission.
 */
export async function runExtensionHealthCheck(host: ExtensionHealthHost, name: string): Promise<void> {
  const entry = host.entries.get(name);
  if (!entry?.service || entry.state !== 'active') return;

  const { checkHealth } = entry.service as ExtensionServiceLifecycle;
  if (!checkHealth) return;

  let warnings: ExtensionWarning[];
  try {
    const raw = await checkHealth.call(entry.service);
    const parsed = ExtensionWarningSchema.array().safeParse(raw);
    if (!parsed.success) {
      console.error(`[ExtensionCoordinator] checkHealth for "${name}" returned invalid data:`, parsed.error);
      warnings = [];
    } else {
      warnings = parsed.data;
    }
  } catch (err) {
    console.error(`[ExtensionCoordinator] checkHealth threw for "${name}":`, err);
    warnings = [];
  }

  entry.warnings = warnings;

  try {
    await host.bus.emit(ExtensionSubjects.warnings.changed, {
      extensionName: name,
      // Snapshot copy: safeParse already produces fresh objects, but spreading
      // the array prevents subscriber mutations from leaking back into
      // entry.warnings, matching the warnings.list RPC contract.
      warnings: [...warnings],
    });
  } catch (err) {
    console.error(`[ExtensionCoordinator] warnings.changed emit failed for "${name}":`, err);
  }
}

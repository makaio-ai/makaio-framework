import { teardownWasObserved, type ConnectorTeardownResult } from '@makaio/contracts';
import type { AdapterRuntimeEntry, LoadedAdapter } from './adapter-runtime-types.js';
import type { DeinitializedAdapterIdentity } from './adapter-runtime-deinitialization.js';

/**
 * Build one exact deinitialization identity from a still-managed runtime slot.
 * @param adapterEntries - Managed runtime slots keyed by runtime adapter ID.
 * @param machineId - Machine hosting the runtime slot.
 * @param adapterId - Runtime identifier of the slot.
 * @param adapterName - Stable adapter implementation name.
 * @returns Exact identity for lifecycle publication.
 */
export function deinitializedAdapterIdentity(
  adapterEntries: ReadonlyMap<string, AdapterRuntimeEntry>,
  machineId: string,
  adapterId: string,
  adapterName: string,
): DeinitializedAdapterIdentity {
  const entry = adapterEntries.get(adapterId);
  if (entry === undefined) throw new Error(`Managed adapter ${adapterId} has no recorded runtime owner`);
  return { adapterId, adapterName, machineId, ownerInstanceId: entry.ownerInstanceId };
}

/**
 * Remove the exact definition and package tracking still owned by a deferred deregistration.
 * @param loadedAdapters - Mutable loaded definitions by stable adapter name.
 * @param adapterEntries - Mutable runtime slots by runtime adapter ID.
 * @param packageAdapters - Mutable package-to-adapter-name tracking.
 * @param adapterName - Stable name whose original definition may be removed.
 * @param adapter - Exact definition that requested deregistration.
 * @param adapterId - Runtime identifier that must remain absent before cleanup.
 */
export function completeDeferredAdapterDeregistration(
  loadedAdapters: Map<string, LoadedAdapter>,
  adapterEntries: Map<string, AdapterRuntimeEntry>,
  packageAdapters: Map<string, string[]>,
  adapterName: string,
  adapter: LoadedAdapter,
  adapterId: string,
): void {
  if (loadedAdapters.get(adapterName) !== adapter || adapterEntries.has(adapterId)) return;
  loadedAdapters.delete(adapterName);
  const packageAdapterNames = packageAdapters.get(adapter.packageName);
  if (packageAdapterNames === undefined) return;
  const remaining = packageAdapterNames.filter((name) => name !== adapterName);
  if (remaining.length === 0) packageAdapters.delete(adapter.packageName);
  else packageAdapters.set(adapter.packageName, remaining);
}

/**
 * Remove one stable adapter name from package tracking.
 * @param packageAdapters - Mutable package-to-adapter-name tracking.
 * @param packageName - Package that contributed the adapter.
 * @param adapterName - Stable name to remove.
 */
export function removeAdapterNameFromPackageTracking(
  packageAdapters: Map<string, string[]>,
  packageName: string,
  adapterName: string,
): void {
  const names = packageAdapters.get(packageName);
  if (names === undefined) return;
  const remaining = names.filter((name) => name !== adapterName);
  if (remaining.length === 0) packageAdapters.delete(packageName);
  else packageAdapters.set(packageName, remaining);
}

/**
 * Finalize only the exact retirement flight that installed its completion handler.
 * @param adapterEntries - Mutable runtime slots by runtime adapter ID.
 * @param adapterId - Runtime identifier of the retiring slot.
 * @param instance - Handle owned by the flight.
 * @param flight - Exact flight whose completion settled.
 * @param report - Evidence established by the final close result.
 */
export function completeAdapterRetirementFlight(
  adapterEntries: Map<string, AdapterRuntimeEntry>,
  adapterId: string,
  instance: AdapterRuntimeEntry['instance'],
  flight: Extract<AdapterRuntimeEntry, { state: 'retiring' }>['flight'],
  report: ConnectorTeardownResult,
): void {
  const current = adapterEntries.get(adapterId);
  if (current?.state !== 'retiring' || current.instance !== instance || current.flight !== flight) return;
  if (teardownWasObserved(report.evidence)) adapterEntries.delete(adapterId);
  else adapterEntries.set(adapterId, { state: 'retiring', instance, ownerInstanceId: current.ownerInstanceId, report });
}

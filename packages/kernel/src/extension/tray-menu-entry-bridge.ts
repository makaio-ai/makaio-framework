import type { IMakaioBus } from '@makaio/bus-core';
import { TrayMenuSubjects, type TrayMenuEntry } from '@makaio/services-core/tray-menu';
import type { KernelMakaioExtension } from './types.js';

/**
 * Bridge a static extension tray manifest through the tray menu bus contract.
 * @param bus - Bus instance that owns the tray menu service request
 * @param pkg - Extension that declares a tray manifest
 * @returns A promise that resolves when the registration RPC completes, or
 *   resolves immediately when the extension has no tray manifest.
 */
export async function registerPackageTrayMenuEntry(bus: IMakaioBus, pkg: KernelMakaioExtension): Promise<void> {
  if (!pkg.tray) return;

  const entry = buildTrayMenuEntry(pkg);
  await bus.request(TrayMenuSubjects.register, { entry });
}

/**
 * Remove a static extension tray manifest's entry from the live tray menu.
 *
 * Mirrors {@link registerPackageTrayMenuEntry} so a coordinator-internal
 * restart's disable leaves no stale, clickable entry for an extension that is
 * no longer running. Uses
 * the same `entryId` derivation as registration so the two calls always
 * target the same tray menu service entry.
 * @param bus - Bus instance that owns the tray menu service request
 * @param pkg - Extension that declares a tray manifest
 * @returns A promise that resolves when the unregistration RPC completes, or
 *   resolves immediately when the extension has no tray manifest.
 */
export async function unregisterPackageTrayMenuEntry(bus: IMakaioBus, pkg: KernelMakaioExtension): Promise<void> {
  if (!pkg.tray) return;

  await bus.request(TrayMenuSubjects.unregister, { packageName: pkg.name, entryId: trayEntryId(pkg.tray) });
}

/**
 * Convert an extension tray manifest into a tray menu service entry.
 * @param pkg - Extension that declares a tray manifest
 * @returns Tray menu entry for the extension manifest
 */
function buildTrayMenuEntry(pkg: KernelMakaioExtension): TrayMenuEntry {
  const tray = pkg.tray;
  if (!tray) {
    throw new Error(`[tray-menu-entry-bridge] extension "${pkg.name}" does not declare a tray entry`);
  }

  return {
    packageName: pkg.name,
    entryId: trayEntryId(tray),
    label: tray.label,
    section: tray.section ?? 'views',
    // Manifest-bridged entries use a fixed default priority. Extensions
    // that need ordering control re-register dynamically via the bus.
    priority: 50,
    enabled: true,
    metadata: tray.opensWindow
      ? { registrationId: `${pkg.name}:${tray.opensWindow}` }
      : tray.action
        ? { action: tray.action }
        : undefined,
  };
}

/**
 * Derive the tray menu service entry ID for a static tray manifest.
 *
 * Shared by {@link buildTrayMenuEntry} and {@link unregisterPackageTrayMenuEntry}
 * so registration and unregistration can never target different entry IDs
 * for the same manifest.
 * @param tray - Extension's static tray manifest.
 * @returns Entry ID used to key the tray menu service registration.
 */
function trayEntryId(tray: NonNullable<KernelMakaioExtension['tray']>): string {
  return tray.opensWindow ?? tray.action ?? 'default';
}

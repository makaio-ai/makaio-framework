import type { IMakaioBus } from '@makaio/bus-core';
import { type MakaioExtension } from '@makaio/contracts';
import { TrayMenuSubjects, type TrayMenuEntry } from '@makaio/services-core/tray-menu';

/**
 * Bridge a static extension tray manifest through the tray menu bus contract.
 * @param bus - Bus instance that owns the tray menu service request
 * @param pkg - Extension that declares a tray manifest
 * @returns A promise that resolves when the registration RPC completes, or
 *   resolves immediately when the extension has no tray manifest.
 */
export async function registerPackageTrayMenuEntry(bus: IMakaioBus, pkg: MakaioExtension): Promise<void> {
  if (!pkg.tray) return;

  const entry = buildTrayMenuEntry(pkg);
  await bus.request(TrayMenuSubjects.register, { entry });
}

/**
 * Convert an extension tray manifest into a tray menu service entry.
 * @param pkg - Extension that declares a tray manifest
 * @returns Tray menu entry for the extension manifest
 */
function buildTrayMenuEntry(pkg: MakaioExtension): TrayMenuEntry {
  const tray = pkg.tray;
  if (!tray) {
    throw new Error(`[tray-menu-entry-bridge] extension "${pkg.name}" does not declare a tray entry`);
  }

  return {
    packageName: pkg.name,
    entryId: tray.opensWindow ?? tray.action ?? 'default',
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

/**
 * Bus operation wrappers for client inventory and binary management.
 *
 * Encapsulates client-domain RPC calls and event subscriptions used by
 * the setup flow, keeping bus subject access isolated from higher-level
 * controllers.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { SetupClientBinaryInventory } from '../types.js';

/**
 * Result of loading the full client inventory from the bus.
 */
export interface ClientInventoryResult {
  /** Global scan results (clientId → detected global version or null). */
  readonly globalResults: ReadonlyMap<string, string | null>;
  /** Managed client entries keyed by clientId. */
  readonly managedClients: ReadonlyMap<string, SetupClientBinaryInventory>;
}

/**
 * Scans for global client binaries and retrieves the managed client list.
 *
 * Combines a `client.scan` for global PATH detection with a `client.list`
 * for managed inventory in a single logical operation.
 * @param bus - The bus instance.
 * @param targets - Client targets to scan (clientId + binaryName pairs).
 * @returns Combined global scan and managed inventory result.
 */
export async function loadClientInventory(
  bus: IMakaioBus,
  targets: readonly { clientId: string; binaryName: string }[],
): Promise<ClientInventoryResult> {
  const [scanResponse, listResponse] = await Promise.all([
    bus.request(ClientSubjects.scan, {
      targets: targets.map(({ clientId, binaryName }) => ({
        clientId,
        binaryName,
      })),
    }),
    bus.request(ClientSubjects.list, {}),
  ]);

  const globalResults = new Map<string, string | null>();
  for (const result of scanResponse.results) {
    globalResults.set(result.clientId, result.version ?? null);
  }

  const managedClients = new Map<string, SetupClientBinaryInventory>();
  for (const client of listResponse.clients) {
    managedClients.set(client.clientId, {
      clientId: client.clientId,
      installedVersions: client.installedVersions.map((v) => v.version),
      activeVersion: client.activeVersion,
      pinnedVersion: client.pinnedVersion,
    });
  }

  return { globalResults, managedClients };
}

/**
 * Activates managed binary pins for the given clients.
 *
 * For each client with a non-null pinned version, the following logic applies:
 * - If `activeVersion === pinnedVersion`: no-op (already at the correct version).
 * - If `pinnedVersion` is in `installedVersions` but not active: calls
 *   `client.setActive` to promote the installed version.
 * - Otherwise: calls `client.update` and waits for the install job to complete
 *   via the `client.installJob.completed` event.
 * @param bus - The bus instance.
 * @param managedClients - Map of clientId to managed inventory.
 * @throws If a binary install job completes with status `'error'`.
 */
export async function activateManagedPins(
  bus: IMakaioBus,
  managedClients: ReadonlyMap<string, SetupClientBinaryInventory>,
): Promise<void> {
  for (const [, client] of managedClients) {
    if (client.pinnedVersion === null) continue;

    // Already active at the pinned version — nothing to do.
    if (client.activeVersion === client.pinnedVersion) continue;

    if (client.installedVersions.includes(client.pinnedVersion)) {
      // Pin is installed but not active — promote without reinstalling.
      await bus.request(ClientSubjects.setActive, {
        clientId: client.clientId,
        version: client.pinnedVersion,
      });
      continue;
    }

    // Pin is not installed — trigger an update job and wait for completion.
    const updateResponse = await bus.request(ClientSubjects.update, {
      clientId: client.clientId,
    });

    /** Maximum time to wait for a binary install job before giving up. */
    const INSTALL_TIMEOUT_MS = 120_000;

    await new Promise<void>((resolve, reject) => {
      // The unsubscribe handle from bus.on is captured in a mutable ref so
      // the timer callback can reach it even though the timer is created
      // before bus.on returns.
      const unsubRef = { fn: (): void => undefined };

      const timer = setTimeout(() => {
        unsubRef.fn();
        reject(new Error(`Binary install for ${client.clientId} timed out after ${INSTALL_TIMEOUT_MS / 1000}s`));
      }, INSTALL_TIMEOUT_MS);

      unsubRef.fn = bus.on(
        ClientSubjects.installJob.completed,
        (ctx) => {
          clearTimeout(timer);
          unsubRef.fn();
          if (ctx.payload.status === 'success') {
            resolve();
          } else {
            reject(
              new Error(
                `Binary install failed for ${client.clientId}: ${ctx.payload.error?.message ?? 'unknown error'}`,
              ),
            );
          }
        },
        { filter: { jobId: updateResponse.jobId } },
      );
    });
  }
}

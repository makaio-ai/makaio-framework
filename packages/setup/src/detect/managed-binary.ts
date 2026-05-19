import type {
  SetupClientEntry,
  SetupClientBinaryInventory,
  ManagedBinaryState,
  ManagedRecommendation,
} from '../types.js';

/**
 * Input data for building managed binary states.
 */
export interface ManagedBinaryBuildInput {
  /** The full client catalog. */
  readonly catalog: readonly SetupClientEntry[];
  /** Global scan results (detected on PATH). */
  readonly globalResults: ReadonlyMap<string, string | null>;
  /** Managed client inventory entries keyed by clientId. */
  readonly managedClients: ReadonlyMap<string, SetupClientBinaryInventory>;
}

/**
 * Determines the recommended action for a single managed binary.
 * @param managed - The managed client inventory, or null if not in managed catalog.
 * @returns The recommended action.
 */
export function recommendManagedAction(managed: SetupClientBinaryInventory | null): ManagedRecommendation {
  if (managed === null) return 'global-only';
  if (managed.pinnedVersion === null) return 'global-only';
  if (managed.activeVersion !== null && managed.activeVersion === managed.pinnedVersion) {
    return 'managed-active';
  }
  if (managed.installedVersions.includes(managed.pinnedVersion)) {
    return 'activate-installed-pin';
  }
  return 'install-and-activate-pin';
}

/**
 * Builds the managed binary state for each client in the catalog.
 * @param input - Catalog, global scan results, and managed inventory.
 * @returns Managed binary states for all catalog clients.
 */
export function buildManagedBinaryStates(input: ManagedBinaryBuildInput): ManagedBinaryState[] {
  const { catalog, managedClients } = input;

  return catalog.map((entry) => {
    const managed = managedClients.get(entry.clientId) ?? null;
    return {
      clientId: entry.clientId,
      binaryName: entry.binaryName,
      recommendation: recommendManagedAction(managed),
      activeVersion: managed?.activeVersion ?? null,
      pinnedVersion: managed?.pinnedVersion ?? null,
    };
  });
}

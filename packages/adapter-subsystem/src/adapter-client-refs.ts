import type { AdapterClientRef } from '@makaio/contracts';

/** Runtime options used when resolving an adapter's default client. */
export interface ResolveDefaultClientIdOptions {
  /** Persisted or requested client ID override. */
  readonly clientId?: string;
}

/**
 * Clone adapter client references into adapter-subsystem-owned metadata.
 * @param clients - Client references declared by an adapter contribution.
 * @returns Cloned client references, or undefined when no clients are declared.
 */
export function cloneAdapterClientRefs(
  clients: readonly AdapterClientRef[] | undefined,
): readonly AdapterClientRef[] | undefined {
  if (clients === undefined || clients.length === 0) {
    return undefined;
  }

  return clients.map((client) => ({ ...client }));
}

/**
 * Resolve the default runtime client ID for a loaded adapter.
 *
 * `clientId` remains an initialization-time selected client override, but only
 * while it still references a client declared by the active adapter manifest.
 * When the override is absent or stale, client-backed adapters default to their
 * first declared client ref.
 * @param options - Runtime options that may carry a selected client ID.
 * @param clients - Client refs declared by the adapter contribution.
 * @returns Selected or default client ID, or undefined for API-only adapters.
 */
export function resolveDefaultClientId(
  options: ResolveDefaultClientIdOptions,
  clients: readonly AdapterClientRef[] | undefined,
): string | undefined {
  if (options.clientId !== undefined && clients?.some((client) => client.id === options.clientId)) {
    return options.clientId;
  }

  return clients?.[0]?.id;
}

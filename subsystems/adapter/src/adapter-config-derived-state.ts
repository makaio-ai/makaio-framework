import { type AdapterFile, type ProviderConfigFile, slugifyProviderConfigName } from '@makaio/contracts/config';
import {
  type AdapterFileConfig,
  type BindingRecord,
  type ProviderConfigAuthSummary,
  type ProviderConfigFileRecord,
} from '@makaio/services-core/adapter-subsystem';
import { type SnapshotState } from './adapter-subsystem-types.js';

/**
 * All derived read-model indexes built from a raw {@link SnapshotState}.
 *
 * Every field is a fully constructed, bus-safe map that the store can assign in
 * one atomic step. No partial update is allowed — always replace all fields
 * together from a single {@link buildAdapterConfigDerivedState} call.
 */
export interface AdapterConfigDerivedState {
  /** Bus-safe provider config records keyed by config ID. */
  readonly providerConfigRecords: Map<string, ProviderConfigFileRecord>;
  /** Reverse index from slugified provider config name to config ID. */
  readonly providerConfigSlugToId: Map<string, string>;
  /** Provider config IDs grouped by provider definition ID, in snapshot order. */
  readonly providerConfigIdsByDefinition: Map<string, string[]>;
  /** Bus-safe adapter read models keyed by adapter name. */
  readonly adapterRecords: Map<string, AdapterFileConfig>;
  /** All binding records for each adapter, in file order. */
  readonly bindingsByAdapter: Map<string, BindingRecord[]>;
  /** All binding records grouped by provider config ID. */
  readonly bindingsByConfig: Map<string, BindingRecord[]>;
  /**
   * Resolved default binding per adapter: the explicit default among enabled
   * bindings, or the first enabled binding when no explicit default exists, or
   * `null` when the adapter has no enabled bindings.
   */
  readonly defaultBindingByAdapter: Map<string, BindingRecord | null>;
  /**
   * Full set of adapter names present in this snapshot.
   *
   * The store compares this against the previous set to detect adapter-set
   * changes and invalidate the log-import provider-keys cache.
   */
  readonly adapterNames: Set<string>;
}

/**
 * Convert a raw provider config file into the bus-safe read model.
 *
 * Raw credential refs are never included in the result. The fixed auth summary
 * exposes only the selected method, mode, optional native account, and whether
 * the selection contains credentials.
 * @param id - Canonical provider config ID.
 * @param raw - Raw file payload.
 * @returns Bus-safe provider config read model.
 */
export function toProviderConfigRecord(id: string, raw: ProviderConfigFile): ProviderConfigFileRecord {
  return {
    id,
    definitionId: raw.definitionId,
    name: raw.name ?? raw.definitionId,
    ...(raw.endpointOverrides ? { endpointOverrides: { ...raw.endpointOverrides } } : {}),
    ...(raw.modelVisibility ? { modelVisibility: { ...raw.modelVisibility } } : {}),
    modelFilterMode: raw.modelFilterMode ?? 'show-all',
    isDefault: raw.isDefault ?? false,
    enabled: raw.enabled ?? true,
    auth: summarizeProviderConfigAuth(raw),
    ...(raw.managedBy ? { managedBy: { ...raw.managedBy } } : {}),
  };
}

/**
 * Build the credential-free auth summary exposed by canonical reads.
 * @param raw - Raw provider config containing credential refs.
 * @returns Fixed summary with no credential refs.
 */
export function summarizeProviderConfigAuth(raw: ProviderConfigFile): ProviderConfigAuthSummary {
  switch (raw.auth.mode) {
    case 'explicit':
      return {
        mode: 'explicit',
        method: { ...raw.auth.method },
        hasCredentials: true,
      };
    case 'inferred':
      return {
        mode: 'inferred',
        method: { ...raw.auth.method },
        ...(raw.auth.account ? { account: { ...raw.auth.account } } : {}),
        hasCredentials: false,
      };
    case 'none':
      return {
        mode: 'none',
        method: { ...raw.auth.method },
        hasCredentials: false,
      };
  }
}

/**
 * Convert raw adapter file bindings into normalized binding records.
 * @param adapterName - Canonical adapter name.
 * @param bindings - Raw file bindings from the adapter file.
 * @returns Normalized binding records with `isDefault` always present.
 */
export function toBindingRecords(adapterName: string, bindings: AdapterFile['bindings']): BindingRecord[] {
  return (bindings ?? []).map((binding) => ({
    adapterName,
    providerConfigId: binding.providerConfigId,
    isDefault: binding.isDefault ?? false,
  }));
}

/**
 * Convert a raw adapter file into the bus-safe adapter read model.
 * @param name - Canonical adapter name.
 * @param raw - Raw file payload.
 * @param bindings - Normalized binding records for this adapter.
 * @returns Bus-safe adapter config read model.
 */
export function toAdapterFileRecord(name: string, raw: AdapterFile, bindings: BindingRecord[]): AdapterFileConfig {
  return {
    name,
    enabled: raw.enabled ?? true,
    ...(raw.displayName !== undefined ? { displayName: raw.displayName } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.helpLinks !== undefined ? { helpLinks: raw.helpLinks.map((link) => ({ ...link })) } : {}),
    ...(raw.instructions !== undefined ? { instructions: raw.instructions } : {}),
    ...(raw.clientId !== undefined ? { clientId: raw.clientId } : {}),
    ...(raw.protocol !== undefined ? { protocol: raw.protocol } : {}),
    ...(raw.providerDefinitionIds !== undefined ? { providerDefinitionIds: [...raw.providerDefinitionIds] } : {}),
    ...(raw.settings ? { settings: structuredClone(raw.settings) as Record<string, unknown> } : {}),
    bindings: bindings.map((binding) => ({ ...binding })),
  };
}

/**
 * Derive the unique provider definition IDs represented by a set of bindings,
 * in the order they first appear.
 * @param bindings - Binding records to scan.
 * @param providerConfigRecords - Current provider config index used to resolve
 *   definition IDs.
 * @returns Unique provider definition IDs in binding order.
 */
export function deriveProviderDefinitionIds(
  bindings: BindingRecord[],
  providerConfigRecords: Map<string, ProviderConfigFileRecord>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const binding of bindings) {
    const config = providerConfigRecords.get(binding.providerConfigId);
    if (!config || seen.has(config.definitionId)) {
      continue;
    }

    seen.add(config.definitionId);
    result.push(config.definitionId);
  }

  return result;
}

/**
 * Build all derived read-model indexes from a raw snapshot in a single pass.
 *
 * The result is a fully constructed {@link AdapterConfigDerivedState} that the
 * store can assign atomically. The `adapterNames` set must be compared against
 * the store's previous known set to decide whether to invalidate the
 * log-import provider-keys cache.
 * @param snapshot - Raw snapshot loaded from the repository or mutated in memory.
 * @returns Fully built derived state ready for atomic assignment.
 */
export function buildAdapterConfigDerivedState(snapshot: SnapshotState): AdapterConfigDerivedState {
  const providerConfigRecords = new Map<string, ProviderConfigFileRecord>();
  const providerConfigSlugToId = new Map<string, string>();
  const providerConfigIdsByDefinition = new Map<string, string[]>();

  for (const [id, raw] of snapshot.providerConfigs) {
    const record = toProviderConfigRecord(id, raw);
    providerConfigRecords.set(id, record);
    providerConfigSlugToId.set(slugifyProviderConfigName(record.name), id);

    const ids = providerConfigIdsByDefinition.get(record.definitionId) ?? [];
    ids.push(id);
    providerConfigIdsByDefinition.set(record.definitionId, ids);
  }

  const adapterRecords = new Map<string, AdapterFileConfig>();
  const bindingsByAdapter = new Map<string, BindingRecord[]>();
  const bindingsByConfig = new Map<string, BindingRecord[]>();
  const defaultBindingByAdapter = new Map<string, BindingRecord | null>();

  for (const [name, raw] of snapshot.adapters) {
    const bindings = toBindingRecords(name, raw.bindings);
    const record = toAdapterFileRecord(name, raw, bindings);
    const enabledBindings = bindings.filter((binding) => providerConfigRecords.get(binding.providerConfigId)?.enabled);

    adapterRecords.set(name, record);
    bindingsByAdapter.set(name, bindings);
    defaultBindingByAdapter.set(
      name,
      enabledBindings.find((binding) => binding.isDefault) ?? enabledBindings[0] ?? null,
    );

    for (const binding of bindings) {
      const grouped = bindingsByConfig.get(binding.providerConfigId) ?? [];
      grouped.push(binding);
      bindingsByConfig.set(binding.providerConfigId, grouped);
    }
  }

  return {
    providerConfigRecords,
    providerConfigSlugToId,
    providerConfigIdsByDefinition,
    adapterRecords,
    bindingsByAdapter,
    bindingsByConfig,
    defaultBindingByAdapter,
    adapterNames: new Set(adapterRecords.keys()),
  };
}

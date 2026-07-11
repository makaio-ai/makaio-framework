import { type AdapterFile, type ProviderConfigFile } from '@makaio/contracts/config';
import {
  type BindingRecord,
  type CanonicalProviderConfigAuthPayload,
  type CanonicalProviderConfigPatch,
  type CreateCanonicalProviderConfigInputPayload,
} from '@makaio/services-core/adapter-subsystem';

export type { CreateCanonicalProviderConfigInputPayload as ProviderConfigCreateInput };
export type { CanonicalProviderConfigPatch as ProviderConfigPatch };
export type { CanonicalProviderConfigAuthPayload as ProviderConfigAuthInput };

export type AdapterConfigPatch = {
  readonly displayName?: string;
  readonly description?: string;
  readonly helpLinks?: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  readonly instructions?: string;
  readonly clientId?: string;
  readonly protocol?: string;
  readonly providerDefinitionIds?: readonly string[];
  readonly settings?: Record<string, unknown>;
  readonly enabled?: boolean;
};

export interface SnapshotState {
  readonly providerConfigs: Map<string, ProviderConfigFile>;
  readonly adapters: Map<string, AdapterFile>;
}

export interface RemoveBindingsResult {
  readonly changedAdapters: Map<string, AdapterFile>;
  readonly deletedBindings: BindingRecord[];
  readonly defaultChangedBindings: Array<{ adapterName: string; providerConfigId: string }>;
}

/**
 * Clone provider endpoint overrides before they enter the mutable snapshot.
 * @param endpointOverrides - Endpoint overrides from a bus payload.
 * @returns Snapshot-owned clone, or undefined.
 */
export function cloneProviderEndpointOverrides(
  endpointOverrides: ProviderConfigFile['endpointOverrides'],
): ProviderConfigFile['endpointOverrides'] {
  return endpointOverrides ? { ...endpointOverrides } : undefined;
}

/**
 * Clone provider model-visibility overrides before they enter the mutable snapshot.
 * @param modelVisibility - Model visibility map from a bus payload.
 * @returns Snapshot-owned clone, or undefined.
 */
export function cloneProviderModelVisibility(
  modelVisibility: ProviderConfigFile['modelVisibility'],
): ProviderConfigFile['modelVisibility'] {
  return modelVisibility ? { ...modelVisibility } : undefined;
}

/**
 * Clone adapter settings before they enter the mutable snapshot.
 * @param settings - Adapter settings payload.
 * @returns Snapshot-owned deep clone, or undefined.
 */
export function cloneAdapterSettings(settings: AdapterFile['settings']): AdapterFile['settings'] {
  return settings ? structuredClone(settings) : undefined;
}

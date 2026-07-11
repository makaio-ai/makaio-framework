/**
 * Framework-tier UI selectors for provider-config bus records.
 *
 * All types and functions here are host-agnostic and depend only on
 * framework packages (`\@makaio/bus-core`, `\@makaio/contracts`,
 * `\@makaio/services-core`). Host code that needs these views imports from
 * this module so that the framework onboarding hook and the host settings
 * surface share a single, authoritative implementation.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ProtocolId } from '@makaio/contracts/provider';
import {
  AdapterSubsystemSubjects,
  type CompatibleAuthOption,
  type ProviderConfigFileRecord,
} from '@makaio/services-core/adapter-subsystem';
import { ProviderStorageSubjects, type ProviderRecord } from '@makaio/services-core/settings/storage';

/**
 * UI-facing provider-config summary enriched with provider definition metadata.
 */
export interface ProviderConfigSummaryView extends ProviderConfigFileRecord {
  /** Supported wire protocols derived from the backing provider definition. */
  supportedProtocols: ProtocolId[];
}

/**
 * UI-facing provider-config detail enriched with provider definition metadata.
 */
export type ProviderConfigDetailView = ProviderConfigSummaryView;

/**
 * Convert a canonical provider-config record into a UI summary view.
 * @param config - Canonical provider-config record from the adapter subsystem.
 * @param provider - Provider definition used to derive supported protocols.
 * @returns Provider-config summary enriched for UI consumption.
 */
function toSummaryView(
  config: ProviderConfigFileRecord,
  provider: Pick<ProviderRecord, 'endpoints'> | null | undefined,
): ProviderConfigSummaryView {
  return {
    ...config,
    supportedProtocols:
      provider === undefined || provider === null ? [] : (Object.keys(provider.endpoints ?? {}) as ProtocolId[]),
  };
}

/**
 * List provider-config summaries enriched for UI consumption.
 * @param bus - Bus used to load subsystem configs and provider definitions.
 * @param options - Optional list filter.
 * @returns Enriched provider-config summaries.
 */
export async function listProviderConfigSummaryViews(
  bus: IMakaioBus,
  options: { enabled?: boolean } = {},
): Promise<ProviderConfigSummaryView[]> {
  const [{ configs }, { providers }] = await Promise.all([
    bus.request(AdapterSubsystemSubjects.listProviderConfigs, options),
    bus.request(ProviderStorageSubjects.list, {}),
  ]);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));

  return configs.map((config) => toSummaryView(config, providerById.get(config.definitionId)));
}

/**
 * Load one provider-config detail view enriched for UI consumption.
 * @param bus - Bus used to load the safe config summary and provider metadata.
 * @param id - Provider-config identifier.
 * @returns Enriched detail view or `null` when missing.
 */
export async function getProviderConfigDetailView(
  bus: IMakaioBus,
  id: string,
): Promise<ProviderConfigDetailView | null> {
  const { config } = await bus.request(AdapterSubsystemSubjects.getProviderConfig, { id });
  if (config === null) {
    return null;
  }

  const { provider } = await bus.request(ProviderStorageSubjects.get, { id: config.definitionId });
  return toSummaryView(config, provider);
}

/**
 * List adapter-deliverable authentication methods for one provider definition.
 * @param bus - Bus used to query the adapter subsystem.
 * @param definitionId - Provider definition whose auth methods are requested.
 * @returns Safe method declarations with fields/source hints but no credential refs.
 */
export async function listCompatibleAuthOptions(
  bus: IMakaioBus,
  definitionId: string,
): Promise<CompatibleAuthOption[]> {
  const { options } = await bus.request(AdapterSubsystemSubjects.listCompatibleAuthOptions, { definitionId });
  return options;
}

import type { ProviderConfigFile } from '@makaio/contracts/config';
import type { BindingRecord } from '@makaio/services-core/adapter-subsystem';

export interface BindingDefaultPromotionResult {
  readonly bindings: BindingRecord[];
  readonly promoted?: BindingRecord;
}

/**
 * Check whether a provider config can participate in default routing.
 * @param providerConfigs - Provider config snapshot.
 * @param providerConfigId - Provider config identifier.
 * @returns Whether the provider config exists and is enabled.
 */
export function isProviderConfigEnabled(
  providerConfigs: Map<string, ProviderConfigFile>,
  providerConfigId: string,
): boolean {
  const config = providerConfigs.get(providerConfigId);
  return config !== undefined && (config.enabled ?? true);
}

/**
 * Check whether a binding set already has an enabled provider candidate.
 * @param bindings - Binding records to inspect.
 * @param providerConfigs - Provider config snapshot.
 * @returns Whether at least one binding points at an enabled provider config.
 */
export function hasEnabledBinding(
  bindings: readonly Pick<BindingRecord, 'providerConfigId'>[],
  providerConfigs: Map<string, ProviderConfigFile>,
): boolean {
  return bindings.some((binding) => isProviderConfigEnabled(providerConfigs, binding.providerConfigId));
}

/**
 * Promote the first enabled binding and clear defaults when no enabled binding remains.
 * @param bindings - Current binding records after a removal.
 * @param providerConfigs - Provider config snapshot.
 * @returns Normalized bindings and the promoted binding, if any.
 */
export function promoteEnabledBindingDefault(
  bindings: readonly BindingRecord[],
  providerConfigs: Map<string, ProviderConfigFile>,
): BindingDefaultPromotionResult {
  const promoted = bindings.find((binding) => isProviderConfigEnabled(providerConfigs, binding.providerConfigId));
  return {
    bindings: bindings.map((binding) => ({
      ...binding,
      isDefault: binding.providerConfigId === promoted?.providerConfigId,
    })),
    ...(promoted ? { promoted: { ...promoted, isDefault: true } } : {}),
  };
}

/**
 * Promote the first enabled provider config for a definition.
 * @param definitionId - Provider definition ID affected by removal.
 * @param excludedId - Provider config ID being removed.
 * @param providerConfigs - Provider config snapshot to update.
 * @returns New default provider config ID, or null when no enabled candidate remains.
 */
export function promoteEnabledProviderConfigDefault(
  definitionId: string,
  excludedId: string,
  providerConfigs: Map<string, ProviderConfigFile>,
): string | null {
  const candidates = [...providerConfigs.entries()]
    .filter(([id, config]) => id !== excludedId && config.definitionId === definitionId)
    .map(([id, config]) => ({ id, config }));
  const promotedId = candidates.find(({ id }) => isProviderConfigEnabled(providerConfigs, id))?.id ?? null;
  for (const { id, config } of candidates) {
    providerConfigs.set(id, { ...config, isDefault: promotedId !== null && id === promotedId });
  }
  return promotedId;
}

/**
 * Encode an adapter/provider binding pair into a synthetic, injective ID.
 *
 * The binding ID is not persisted as an independent domain key; it mirrors the
 * adapter/provider pair that the service facade exposes over the bus. JSON tuple
 * encoding keeps the shape reversible without relying on delimiter heuristics.
 * @param adapterName - Adapter name.
 * @param providerConfigId - Provider config ID.
 * @returns Synthetic binding ID.
 */
export function createAdapterProviderBindingId(adapterName: string, providerConfigId: string): string {
  return JSON.stringify([adapterName, providerConfigId]);
}

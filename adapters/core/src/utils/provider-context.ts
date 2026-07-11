import type { UnresolvedProviderContext } from '@makaio/contracts';

/**
 * Create the deliberate configless provider state.
 *
 * The closed shape cannot be interpreted as native authentication or ambient
 * credential permission. Adapter startup must either accept a provider-less
 * operation explicitly or fail before creating connector state.
 * @returns Fresh configless provider context.
 */
export function createUnresolvedProviderContext(): UnresolvedProviderContext {
  return { state: 'unresolved' };
}

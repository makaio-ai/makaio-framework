/**
 * MakaioExtension descriptor for the OpenRouter provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the OpenRouter provider.
 */
export const openrouterPackage: MakaioExtension = {
  name: 'provider-openrouter',
  displayName: 'OpenRouter',
  providers: [providerDefinition],
};

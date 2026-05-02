/**
 * MakaioExtension descriptor for the OpenAI provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the OpenAI provider.
 */
export const openaiPackage: MakaioExtension = {
  name: 'provider-openai',
  displayName: 'OpenAI',
  providers: [providerDefinition],
};

import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the OpenAI provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the OpenAI provider.
 */
export const openaiPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'provider-openai',
  displayName: 'OpenAI',
  version: '0.1.0',
  providers: [providerDefinition],
};

/**
 * MakaioExtension descriptor for the NanoGPT provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the NanoGPT provider.
 */
export const nanogptPackage: MakaioExtension = {
  name: 'provider-nanogpt',
  displayName: 'NanoGPT',
  providers: [providerDefinition],
};

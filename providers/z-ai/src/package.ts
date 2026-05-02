/**
 * MakaioExtension descriptor for the Z.AI (GLM) provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the Z.AI (GLM) provider.
 */
export const zAiPackage: MakaioExtension = {
  name: 'provider-z-ai',
  displayName: 'Z.AI (GLM)',
  providers: [providerDefinition],
};

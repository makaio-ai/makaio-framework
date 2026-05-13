/**
 * MakaioExtension descriptor for the Kimi provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the Kimi provider.
 */
export const kimiPackage: MakaioExtension = {
  name: 'provider-kimi',
  displayName: 'Kimi',
  version: '0.1.0',
  providers: [providerDefinition],
};

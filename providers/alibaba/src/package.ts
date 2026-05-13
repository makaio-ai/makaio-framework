/**
 * MakaioExtension descriptor for the Alibaba Model Studio provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the Alibaba Model Studio provider.
 */
export const alibabaPackage: MakaioExtension = {
  name: 'provider-alibaba',
  displayName: 'Alibaba Model Studio',
  version: '0.1.0',
  providers: [providerDefinition],
};

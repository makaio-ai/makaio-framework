/**
 * MakaioExtension descriptor for the Qwen OAuth provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the Qwen OAuth provider.
 */
export const qwenPackage: MakaioExtension = {
  name: 'provider-qwen-acp',
  displayName: 'Qwen OAuth',
  providers: [providerDefinition],
};

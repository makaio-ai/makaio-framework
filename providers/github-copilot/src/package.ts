/**
 * MakaioExtension descriptor for the GitHub Copilot provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the GitHub Copilot provider.
 */
export const githubCopilotPackage: MakaioExtension = {
  name: 'provider-github-copilot',
  displayName: 'GitHub Copilot',
  providers: [providerDefinition],
};

import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the GitHub Copilot provider.
 *
 * Wraps the existing {@link providerDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the GitHub Copilot provider.
 */
export const githubCopilotPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'provider-github-copilot',
  displayName: 'GitHub Copilot',
  version: '0.1.0',
  providers: [providerDefinition],
};

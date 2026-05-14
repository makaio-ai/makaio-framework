import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the GitHub Copilot client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the GitHub Copilot client.
 *
 * Declares the GitHub Copilot SDK-only integration as a client with no native
 * tools. The `copilot` binary is used for CLI detection only. All tool
 * invocations default to `always-ask` approval policy.
 */
export const githubCopilotPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'github-copilot',
  displayName: 'GitHub Copilot',
  version: '0.1.0',
  clients: [clientDefinition],
};

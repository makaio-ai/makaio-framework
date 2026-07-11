import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the GitHub Copilot SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { GitHubCopilotSdkAdapterName } from './constants.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the GitHub Copilot SDK adapter.
 *
 * Uses the GitHub Copilot SDK and its managed CLI transport, so it declares no
 * Makaio HTTP inference protocol.
 */
export const githubCopilotSdkPackage: MakaioNodeExtension<IMakaioBus> = {
  name: GitHubCopilotSdkAdapterName,
  displayName: 'GitHub Copilot',
  version: '0.1.0',
  dependencies: [dep('provider-github-copilot', undefined, true)],
  adapters: [
    {
      manifest: {
        name: GitHubCopilotSdkAdapterName,
        displayName: 'GitHub Copilot',
        description: 'GitHub Copilot SDK integration',
        ...(clients ? { clients } : {}),
        protocols: [],
      },
      definition: adapterDefinition,
    },
  ],
};

export default githubCopilotSdkPackage;

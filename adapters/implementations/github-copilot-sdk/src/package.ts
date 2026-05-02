/**
 * MakaioExtension descriptor for the GitHub Copilot SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { GitHubCopilotSdkAdapterName } from './constants.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the GitHub Copilot SDK adapter.
 *
 * API-only adapter that targets the GitHub Copilot completions endpoint.
 * Declares the `openai` wire protocol since GitHub Copilot exposes an
 * OpenAI-compatible chat completions interface.
 */
export const githubCopilotSdkPackage: MakaioExtension = {
  name: GitHubCopilotSdkAdapterName,
  displayName: 'GitHub Copilot',
  dependencies: ['provider-github-copilot'],
  adapters: [
    {
      manifest: {
        name: GitHubCopilotSdkAdapterName,
        displayName: 'GitHub Copilot',
        description: 'GitHub Copilot SDK integration',
        ...(clients ? { clients } : {}),
        protocols: ['openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default githubCopilotSdkPackage;

/**
 * MakaioExtension descriptor for the Qwen ACP adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { QwenAcpAdapterName } from './constants.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Qwen ACP adapter.
 *
 * Communicates with the Qwen Code CLI over stdio via the Agent Client
 * Protocol (ACP). Declares the `openai` wire protocol because the adapter
 * uses an OpenAI-compatible completions interface under the hood.
 */
export const qwenAcpPackage: MakaioExtension = {
  name: QwenAcpAdapterName,
  displayName: 'Qwen Code (ACP)',
  dependencies: ['provider-qwen-acp'],
  adapters: [
    {
      manifest: {
        name: QwenAcpAdapterName,
        displayName: 'Qwen Code (ACP)',
        description: 'Qwen Code CLI via Agent Client Protocol',
        ...(clients ? { clients } : {}),
        protocols: ['openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default qwenAcpPackage;

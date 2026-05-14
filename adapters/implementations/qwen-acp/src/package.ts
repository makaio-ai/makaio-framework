import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Qwen ACP adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
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
export const qwenAcpPackage: MakaioNodeExtension<IMakaioBus> = {
  name: QwenAcpAdapterName,
  displayName: 'Qwen Code (ACP)',
  version: '0.1.0',
  dependencies: [dep('provider-qwen-acp')],
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

/**
 * MakaioExtension descriptor for the OpenAI Node adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { OpenAINodeAdapterName } from './constants.js';

/**
 * Package descriptor for the OpenAI Node adapter.
 *
 * API-only adapter using the official OpenAI Node SDK. Declares the `openai`
 * wire protocol, which also covers compatible third-party endpoints
 * (Azure OpenAI, DeepSeek, etc.).
 */
export const openaiNodePackage: MakaioExtension = {
  name: OpenAINodeAdapterName,
  displayName: 'OpenAI',
  dependencies: [
    'provider-openai',
    'provider-nanogpt',
    'provider-openrouter',
    'provider-z-ai',
    'provider-alibaba',
    'provider-opencode-go',
  ],
  adapters: [
    {
      manifest: {
        name: OpenAINodeAdapterName,
        displayName: 'OpenAI',
        description: 'OpenAI chat completions with streaming and tool calling',
        protocols: ['openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default openaiNodePackage;

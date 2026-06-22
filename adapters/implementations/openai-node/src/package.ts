import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the OpenAI Node adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { OpenAINodeAdapterName } from './constants.js';

/**
 * Package descriptor for the OpenAI Node adapter.
 *
 * API-only adapter using the official OpenAI Node SDK. Declares the `openai`
 * wire protocol, which also covers compatible third-party endpoints
 * (Azure OpenAI, DeepSeek, etc.).
 */
export const openaiNodePackage: MakaioNodeExtension<IMakaioBus> = {
  name: OpenAINodeAdapterName,
  displayName: 'OpenAI',
  version: '0.1.0',
  dependencies: [
    dep('provider-openai', undefined, true),
    dep('provider-nanogpt', undefined, true),
    dep('provider-openrouter', undefined, true),
    dep('provider-z-ai', undefined, true),
    dep('provider-alibaba', undefined, true),
    dep('provider-opencode-go', undefined, true),
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

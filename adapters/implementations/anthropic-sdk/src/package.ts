/**
 * MakaioExtension descriptor for the Anthropic SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { AnthropicSdkAdapterName } from './constants.js';

/**
 * Package descriptor for the Anthropic SDK adapter.
 *
 * API-only adapter (no client binary dependency). Declares the `anthropic`
 * wire protocol, which covers the native Anthropic Messages API as well as
 * compatible proxies (Z.ai, Alibaba, opencode-go).
 */
export const anthropicSdkPackage: MakaioExtension = {
  name: AnthropicSdkAdapterName,
  displayName: 'Anthropic SDK',
  dependencies: ['provider-anthropic', 'provider-z-ai', 'provider-alibaba', 'provider-opencode-go'],
  adapters: [
    {
      manifest: {
        name: AnthropicSdkAdapterName,
        displayName: 'Anthropic SDK',
        description: 'Anthropic Messages API with streaming, tool calling, and extended thinking',
        protocols: ['anthropic'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default anthropicSdkPackage;

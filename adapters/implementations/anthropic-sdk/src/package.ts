import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Anthropic SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { AnthropicSdkAdapterName } from './constants.js';

/**
 * Package descriptor for the Anthropic SDK adapter.
 *
 * API-only adapter (no client binary dependency). Declares the `anthropic`
 * wire protocol, which covers the native Anthropic Messages API as well as
 * compatible proxies (Z.ai, Alibaba, opencode-go).
 */
export const anthropicSdkPackage: MakaioNodeExtension<IMakaioBus> = {
  name: AnthropicSdkAdapterName,
  displayName: 'Anthropic SDK',
  version: '0.1.0',
  dependencies: [
    dep('provider-anthropic', undefined, true),
    dep('provider-z-ai', undefined, true),
    dep('provider-alibaba', undefined, true),
    dep('provider-opencode-go', undefined, true),
  ],
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

import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Pi SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { PiSdkAdapterName } from './constants.js';
import { providerIds } from './provider.js';

/**
 * Package descriptor for the Pi SDK adapter.
 *
 * Communicates with multiple upstream AI providers (Anthropic, OpenAI, etc.)
 * via the Pi coding agent SDK, which manages its own agentic loop internally.
 * Declares both `anthropic` and `openai` wire protocols because Pi routes
 * internally to either Anthropic Messages or OpenAI Completions endpoints.
 */
export const piSdkPackage: MakaioNodeExtension<IMakaioBus> = {
  name: PiSdkAdapterName,
  displayName: 'Pi SDK',
  version: '0.1.0',
  dependencies: providerIds.map((definitionId) => dep(`provider-${definitionId}`)),
  adapters: [
    {
      manifest: {
        name: PiSdkAdapterName,
        displayName: 'Pi SDK',
        description: 'Pi coding agent SDK wrapper',
        protocols: ['anthropic', 'openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default piSdkPackage;

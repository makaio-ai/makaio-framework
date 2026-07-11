import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Gemini SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import { dep } from '@makaio/contracts';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { GeminiSdkAdapterName } from './constants.js';
import { defaultPresetId } from './provider.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Gemini SDK adapter.
 *
 * Uses the official Google Gemini SDK and therefore declares no Makaio HTTP
 * inference protocol.
 */
export const geminiSdkPackage: MakaioNodeExtension<IMakaioBus> = {
  name: GeminiSdkAdapterName,
  displayName: 'Gemini SDK',
  version: '0.1.0',
  dependencies: [dep('provider-google', undefined, true)],
  adapters: [
    {
      manifest: {
        name: GeminiSdkAdapterName,
        displayName: 'Gemini SDK',
        description: 'Google Gemini SDK integration',
        ...(clients ? { clients } : {}),
        protocols: [],
        defaultProvider: defaultPresetId,
      },
      definition: adapterDefinition,
    },
  ],
};

export default geminiSdkPackage;

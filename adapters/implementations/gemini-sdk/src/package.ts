/**
 * MakaioExtension descriptor for the Gemini SDK adapter.
 *
 * Wraps the existing {@link adapterDefinition} in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this adapter through the unified adapter contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './definition.js';
import { GeminiSdkAdapterName } from './constants.js';

const clients = adapterDefinition.clients;

/**
 * Package descriptor for the Gemini SDK adapter.
 *
 * Uses the official Google Gemini SDK. Declares the `openai` wire protocol
 * because the adapter communicates with Gemini through an OpenAI-compatible
 * completions interface.
 */
export const geminiSdkPackage: MakaioExtension = {
  name: GeminiSdkAdapterName,
  displayName: 'Gemini SDK',
  dependencies: ['provider-google'],
  adapters: [
    {
      manifest: {
        name: GeminiSdkAdapterName,
        displayName: 'Gemini SDK',
        description: 'Google Gemini SDK integration',
        ...(clients ? { clients } : {}),
        protocols: ['openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default geminiSdkPackage;

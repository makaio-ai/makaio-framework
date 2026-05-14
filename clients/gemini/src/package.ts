import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Gemini client.
 *
 * Wraps the existing {@link clientDefinition} in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this client through the unified client contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { clientDefinition } from './definition.js';

/**
 * Package descriptor for the Gemini client.
 *
 * Declares the Google Gemini CLI binary (`gemini`) as an AI assistant client
 * with dynamically discovered native tools and an `always-ask` default
 * approval policy.
 */
export const geminiPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'gemini',
  displayName: 'Gemini',
  version: '0.1.0',
  clients: [clientDefinition],
};

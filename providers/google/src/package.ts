import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Google AI provider.
 *
 * Wraps the existing provider definitions in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';

/**
 * Package descriptor for the Google AI provider.
 *
 * Exposes the API-key provider definition supported by the Gemini adapter.
 */
export const googlePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'provider-google',
  displayName: 'Google AI',
  version: '0.1.0',
  providers: [providerDefinition],
};

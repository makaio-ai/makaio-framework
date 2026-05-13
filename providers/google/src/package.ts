/**
 * MakaioExtension descriptor for the Google AI provider.
 *
 * Wraps the existing provider definitions in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';
import { providerDefinitionOAuth } from './definition-oauth.js';

/**
 * Package descriptor for the Google AI provider.
 *
 * Includes both the API-key and OAuth subscription variants.
 */
export const googlePackage: MakaioExtension = {
  name: 'provider-google',
  displayName: 'Google AI',
  version: '0.1.0',
  providers: [providerDefinition, providerDefinitionOAuth],
};

import type { IMakaioBus } from '@makaio/bus-core';
/**
 * MakaioNodeExtension<IMakaioBus> descriptor for the Anthropic provider.
 *
 * Wraps the existing provider definitions in the standard
 * `MakaioNodeExtension<IMakaioBus>` shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioNodeExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';
import { providerDefinitionOAuth } from './definition-oauth.js';

/**
 * Package descriptor for the Anthropic provider.
 *
 * Includes both the API-key and OAuth subscription variants.
 */
export const anthropicPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'provider-anthropic',
  displayName: 'Anthropic',
  version: '0.1.0',
  providers: [providerDefinition, providerDefinitionOAuth],
};

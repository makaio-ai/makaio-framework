/**
 * MakaioExtension descriptor for the Anthropic provider.
 *
 * Wraps the existing provider definitions in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { providerDefinition } from './definition.js';
import { providerDefinitionOAuth } from './definition-oauth.js';

/**
 * Package descriptor for the Anthropic provider.
 *
 * Includes both the API-key and OAuth subscription variants.
 */
export const anthropicPackage: MakaioExtension = {
  name: 'provider-anthropic',
  displayName: 'Anthropic',
  providers: [providerDefinition, providerDefinitionOAuth],
};

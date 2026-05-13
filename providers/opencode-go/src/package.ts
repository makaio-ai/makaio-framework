/**
 * MakaioExtension descriptor for the OpenCode Go provider.
 *
 * Wraps the existing provider definitions in the standard
 * {@link MakaioExtension} shape so the runtime coordinator can discover and
 * register this provider through the unified provider contribution surface.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { openaiProviderDefinition, anthropicProviderDefinition } from './definition.js';

/**
 * Package descriptor for the OpenCode Go provider.
 *
 * Includes both the OpenAI-compatible and Anthropic-compatible gateway
 * variants served by the same upstream endpoint.
 */
export const opencodeGoPackage: MakaioExtension = {
  name: 'provider-opencode-go',
  displayName: 'OpenCode Go',
  version: '0.1.0',
  providers: [openaiProviderDefinition, anthropicProviderDefinition],
};

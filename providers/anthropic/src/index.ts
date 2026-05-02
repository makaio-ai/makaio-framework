import { providerDefinition } from './definition.js';
import { providerDefinitionOAuth } from './definition-oauth.js';

/** Anthropic provider definitions exposed by this package. */
export const providerDefinitions = [providerDefinition, providerDefinitionOAuth];

export { providerDefinition, providerDefinitionOAuth };
/** Anthropic provider package descriptor for unified package discovery. */
export { anthropicPackage } from './package.js';

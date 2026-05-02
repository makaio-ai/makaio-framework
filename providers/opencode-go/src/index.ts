import { openaiProviderDefinition, anthropicProviderDefinition } from './definition.js';

// This package intentionally ships multiple provider definitions because the
// same upstream gateway exposes both OpenAI- and Anthropic-compatible
// protocols under one package identity.
/** OpenCode Go provider definitions exposed by this package. */
export const providerDefinitions = [openaiProviderDefinition, anthropicProviderDefinition];

export { openaiProviderDefinition, anthropicProviderDefinition };
/** OpenCode Go provider package descriptor for unified package discovery. */
export { opencodeGoPackage } from './package.js';

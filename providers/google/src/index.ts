import { providerDefinition } from './definition.js';
import { providerDefinitionOAuth } from './definition-oauth.js';

/** Google provider definitions exposed by this package. */
export const providerDefinitions = [providerDefinition, providerDefinitionOAuth];

export { providerDefinition, providerDefinitionOAuth };
/** Google provider package descriptor for unified package discovery. */
export { googlePackage } from './package.js';

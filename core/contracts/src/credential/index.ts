/**
 * Public API for the credential contracts.
 * @packageDocumentation
 */

export {
  CredentialNamespace,
  CredentialStoreGrantRequestSchema,
  CredentialStoreGrantResponseSchema,
  CredentialStoreRequestSchema,
  CredentialStoreResponseSchema,
  CredentialSubjects,
} from './namespace.js';
export type { CredentialStoreGrantRequest, CredentialStoreGrantResponse, CredentialStoreRequest } from './namespace.js';
export { CredentialChangeSequenceSchema } from './change-sequence.js';
export type { CredentialChangeSequence } from './change-sequence.js';
export { createSecret, isSecret } from './secret.js';
export type { Secret } from './secret.js';
export type { CredentialResolution } from './resolution.js';
export type { CredentialResolverContribution, CredentialResolverInput } from './resolver-contribution.js';

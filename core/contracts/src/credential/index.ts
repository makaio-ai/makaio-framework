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

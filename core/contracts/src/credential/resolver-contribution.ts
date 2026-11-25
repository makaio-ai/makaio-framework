import type { CallContext, ExtensionName } from '@makaio/core';
import type { JsonValue } from '../shared/json-value.js';
import type { CredentialResolution } from './resolution.js';

/**
 * Input of a credential resolution as set by the kernel.
 */
export interface CredentialResolverInput {
  /** The extension that requested the credential. */
  readonly requester: ExtensionName;
  /** The purpose the credential is requested for. */
  readonly purpose: string;
  /** Optional purpose-specific target the credential is requested for. */
  readonly target?: JsonValue;
  /** Cancellation of a run-scoped request, when supplied by the worker. */
  readonly signal?: AbortSignal;
}

/**
 * The host's single credential provider contribution.
 */
export interface CredentialResolverContribution {
  /**
   * Resolves a purpose after checking the host-declared right.
   * @param call - Unchanged context of the requesting operation.
   * @param input - Kernel-set requester, purpose and optional target.
   * @returns The credential or business failure.
   */
  resolve(call: CallContext, input: CredentialResolverInput): Promise<CredentialResolution>;
}

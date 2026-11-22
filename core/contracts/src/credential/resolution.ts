import type { Secret } from './secret.js';

/**
 * Business outcome of credential resolution.
 *
 * Either the resolved secret, optionally with an expiry, or a failure with a
 * code chosen by the provider.
 * @typeParam C - Union of the failure codes the provider can return.
 */
export type CredentialResolution<C extends string = string> =
  | {
      /** Resolution succeeded. */
      success: true;
      /** The resolved credential. */
      value: Secret;
      /** Expiry of the credential as an ISO 8601 timestamp, when it expires. */
      expiresAt?: string;
    }
  | {
      /** Resolution failed. */
      success: false;
      /** The business failure. */
      error: {
        /** Machine-readable failure code. */
        code: C;
        /** Human-readable failure description. */
        message: string;
      };
    };

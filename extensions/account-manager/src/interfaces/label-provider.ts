import type { RawCredential } from './credential-source.js';

/** Provider for resolving human-readable account labels. */
export interface ILabelProvider {
  /** Resolves a display label for the account identified by the credential. */
  resolveLabel(credential: RawCredential): Promise<string | null>;
}

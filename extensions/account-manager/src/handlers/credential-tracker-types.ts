import type { IMakaioBus } from '@makaio/bus-core';
import type { ICredentialSource } from '../interfaces/credential-source.js';
import type { ILabelProvider } from '../interfaces/label-provider.js';
import type { IAccountCredentialStore, IAccountMetadataStore } from '../interfaces/account-store.js';

/**
 * A credential source that may optionally resolve human-readable account labels.
 *
 * Sources implementing {@link ILabelProvider} will have their
 * {@link ILabelProvider.resolveLabel} called by {@link LabelResolver}.
 */
export type CredentialSourceWithOptionalLabel = ICredentialSource & Partial<ILabelProvider>;

/**
 * Dependencies injected into {@link CredentialTracker}.
 */
export interface CredentialTrackerDeps {
  /** Bus instance for emitting events. */
  bus: IMakaioBus;
  /** Credential sources to poll. */
  sources: CredentialSourceWithOptionalLabel[];
  /** Credential persistence layer. */
  credentialStore: IAccountCredentialStore;
  /** Public metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
  /**
   * Serializes multi-step mutations per client.
   *
   * Passed in from the orchestrator so poll, switch, label and remove
   * never interleave active-account transitions.
   * @param clientId - Client whose mutation queue should be used
   * @param action - Workflow to run exclusively for that client
   * @returns The workflow result
   */
  withClientMutation<T>(clientId: string, action: () => Promise<T>): Promise<T>;
  /** Polling interval in milliseconds. */
  pollIntervalMs: number;
}

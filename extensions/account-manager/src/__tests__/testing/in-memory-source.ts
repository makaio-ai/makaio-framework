import type {
  CredentialRefreshResult,
  ICredentialSource,
  PreparedNativeCredentialMutation,
  RawCredential,
} from '../../interfaces/credential-source.js';
import type { ILabelProvider } from '../../interfaces/label-provider.js';
import type { AccountUsage } from '../../bus/schemas.js';
import type { IUsageProvider, UsageResult } from '../../interfaces/usage-provider.js';

/**
 * In-memory credential source for testing.
 *
 * Provides controllable read/write behavior without filesystem or keychain access.
 * Optionally implements {@link ILabelProvider} and {@link IUsageProvider} via
 * injectable handler functions for testing those code paths without subclassing.
 */
export class InMemoryCredentialSource implements ICredentialSource, Partial<ILabelProvider>, Partial<IUsageProvider> {
  readonly clientId: string;
  readonly displayName: string;

  private available = true;
  private credential: RawCredential | null = null;
  private writeHistory: RawCredential[] = [];

  /**
   * Present only when {@link setLabelResolver} has been called with a non-undefined function.
   * Declared as an optional property so the {@link ILabelProvider} type guard
   * (`typeof source.resolveLabel === 'function'`) returns false until a resolver is installed.
   */
  resolveLabel?: (credential: RawCredential) => Promise<string | null>;

  /**
   * Present only when {@link setUsageResolver} has been called with a non-undefined function.
   * Declared as an optional property so the {@link IUsageProvider} type guard
   * (`typeof source.resolveUsage === 'function'`) returns false until a resolver is installed.
   */
  resolveUsage?: (credential: RawCredential) => Promise<UsageResult | null>;

  /**
   * Present only when {@link setCredentialKeyExtractor} has been called with a non-undefined function.
   * Declared as an optional property so the `extractCredentialKey` type guard
   * (`typeof source.extractCredentialKey === 'function'`) returns false until an extractor is installed.
   */
  extractCredentialKey?: (rawToken: string) => string | null;

  /**
   * Present only when {@link setCredentialKeyFingerprintMismatchPolicy} has
   * been called with a non-undefined function.
   */
  allowsCredentialKeyFingerprintMismatch?: ICredentialSource['allowsCredentialKeyFingerprintMismatch'];

  /**
   * Present only when {@link setRefreshHandler} has been called with a non-undefined function.
   * Declared as an optional property so the `refreshIfNeeded` type guard
   * (`typeof source.refreshIfNeeded === 'function'`) returns false until a handler is installed.
   */
  refreshIfNeeded?: (credential: RawCredential) => Promise<CredentialRefreshResult>;

  /**
   * @param clientId - Client identifier for this source
   * @param displayName - Human-readable display name
   */
  constructor(clientId: string, displayName: string) {
    this.clientId = clientId;
    this.displayName = displayName;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async read(): Promise<RawCredential | null> {
    return this.credential;
  }

  /**
   * Write a credential to this in-memory source.
   *
   * Matches the real native-storage contract: after a write, {@link read}
   * returns the written credential. Test code that calls {@link setCredential}
   * before a switch should not assume the pre-write value survives after
   * {@link AccountManager} calls `source.write()`.
   * @param credential - Credential to store
   */
  async write(credential: RawCredential): Promise<void> {
    this.credential = credential;
    this.writeHistory.push(credential);
  }

  /** Clear the in-memory native credential. */
  async clear(): Promise<void> {
    this.credential = null;
  }

  /**
   * Prepare an in-memory write with the same generation-checked rollback as real sources.
   * @param credential - Target credential to materialize.
   * @returns Prepared mutation retaining the previous value privately.
   */
  async prepareNativeCredentialMutation(credential: RawCredential): Promise<PreparedNativeCredentialMutation> {
    const previous = this.credential === null ? null : structuredClone(this.credential);
    const target = structuredClone(credential);
    await this.write(target);
    return {
      coordination: 'released',
      rollback: async () => {
        if (this.credential?.token !== target.token) {
          return { status: 'superseded', coordination: 'released' };
        }
        if (previous === null) {
          await this.clear();
        } else {
          await this.write(previous);
        }
        return { status: 'restored', coordination: 'released' };
      },
    };
  }

  // --- Test helpers ---

  /**
   * Set whether this source reports as available.
   * @param available - New availability value
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /**
   * Set the credential that read() will return.
   * @param credential - Credential to serve, or null to simulate no credential
   */
  setCredential(credential: RawCredential | null): void {
    this.credential = credential;
  }

  /**
   * Install a label resolver to make this source implement {@link ILabelProvider}.
   *
   * When `fn` is provided, assigns `resolveLabel` on the instance so the
   * {@link ILabelProvider} type guard returns true. When called with `undefined`,
   * deletes the property so the type guard returns false again.
   * @param fn - Resolver function, or undefined to disable
   */
  setLabelResolver(fn: ((credential: RawCredential) => Promise<string | null>) | undefined): void {
    if (fn === undefined) {
      delete this.resolveLabel;
    } else {
      this.resolveLabel = fn;
    }
  }

  /**
   * Install a usage resolver to make this source implement {@link IUsageProvider}.
   *
   * Accepts a callback returning plain `AccountUsage` for convenience — the
   * helper wraps the result in a {@link UsageResult} envelope automatically so
   * existing test sites do not need updating.
   *
   * When `fn` is provided, assigns `resolveUsage` on the instance so the
   * {@link IUsageProvider} type guard returns true. When called with `undefined`,
   * deletes the property so the type guard returns false again.
   * @param fn - Resolver function, or undefined to disable
   */
  setUsageResolver(fn: ((credential: RawCredential) => Promise<AccountUsage | null>) | undefined): void {
    if (fn === undefined) {
      delete this.resolveUsage;
    } else {
      this.resolveUsage = async (credential) => {
        const usage = await fn(credential);
        return usage ? { usage } : null;
      };
    }
  }

  /**
   * Install a credential key extractor to make this source implement the
   * `extractCredentialKey` optional method on {@link ICredentialSource}.
   *
   * When `fn` is provided, assigns `extractCredentialKey` on the instance so the
   * type guard (`typeof source.extractCredentialKey === 'function'`) returns true.
   * When called with `undefined`, deletes the property so the guard returns false.
   * @param fn - Extractor function, or undefined to disable
   */
  setCredentialKeyExtractor(fn: ((rawToken: string) => string | null) | undefined): void {
    if (fn === undefined) {
      delete this.extractCredentialKey;
    } else {
      this.extractCredentialKey = fn;
    }
  }

  /**
   * Install a credential-key/fingerprint mismatch policy for tests that model
   * a real source-owned fingerprint-format transition.
   * @param fn - Policy function, or undefined to disable.
   */
  setCredentialKeyFingerprintMismatchPolicy(
    fn: ICredentialSource['allowsCredentialKeyFingerprintMismatch'] | undefined,
  ): void {
    if (fn === undefined) {
      delete this.allowsCredentialKeyFingerprintMismatch;
    } else {
      this.allowsCredentialKeyFingerprintMismatch = fn;
    }
  }

  /**
   * Install a refresh handler to make this source implement the
   * `refreshIfNeeded` optional method on {@link ICredentialSource}.
   *
   * When `fn` is provided, assigns `refreshIfNeeded` on the instance so the
   * type guard (`typeof source.refreshIfNeeded === 'function'`) returns true.
   * When called with `undefined`, deletes the property so the guard returns false.
   * @param fn - Refresh handler function, or undefined to disable
   */
  setRefreshHandler(fn: ((credential: RawCredential) => Promise<CredentialRefreshResult>) | undefined): void {
    if (fn === undefined) {
      delete this.refreshIfNeeded;
    } else {
      this.refreshIfNeeded = fn;
    }
  }

  /**
   * Get the history of credentials written to this source.
   * @returns A copy of the write history array
   */
  getWriteHistory(): RawCredential[] {
    return [...this.writeHistory];
  }

  /**
   * Get the last credential written to this source.
   * @returns The last written credential, or undefined if nothing was written
   */
  getLastWritten(): RawCredential | undefined {
    return this.writeHistory[this.writeHistory.length - 1];
  }
}

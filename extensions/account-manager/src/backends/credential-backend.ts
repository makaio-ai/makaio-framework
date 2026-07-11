/**
 * Location-bound credential I/O.
 *
 * Each instance is pre-configured with a target location (keychain entry
 * or file path). Sources call read/write without knowing the mechanism.
 */
export interface ICredentialBackend {
  /** Read the credential value from the pre-configured location. */
  read(): Promise<string | null>;
  /** Write a credential value to the pre-configured location. */
  write(value: string): Promise<void>;
  /** Remove the credential value from the pre-configured location. */
  clear(): Promise<void>;
  /**
   * Rebind a path-backed backend to an already pinned canonical config directory.
   * Location-independent backends omit this capability.
   * @param configDir - Canonical config directory retained by the source lock.
   * @returns Backend addressing the same credential filename below that directory.
   */
  bindToCanonicalConfigDirectory?(configDir: string): ICredentialBackend;
}

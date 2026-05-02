import { AsyncEntry } from '@napi-rs/keyring';
import type { ICredentialBackend } from './credential-backend.js';

/**
 * Native keychain backend using `@napi-rs/keyring`.
 *
 * Uses the async (non-blocking) `AsyncEntry` API from the Rust `keyring-rs`
 * crate via napi-rs for direct Security framework access. When loaded in a
 * signed Electron binary, keychain prompts show the app name ("Makaio")
 * instead of "security". Writes preserve ACLs via
 * `SecKeychainItemModifyAttributesAndData`.
 */
export class KeyringBackend implements ICredentialBackend {
  /**
   * @param service - The keychain service name
   * @param account - The keychain account name
   */
  public constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  /**
   * Reads the credential value from the native keychain using the async API.
   *
   * Returns null only when the entry does not exist (`NoEntry`). All other
   * errors (locked keychain, permission denied, etc.) are re-thrown so callers
   * can distinguish a missing credential from an inaccessible keychain.
   * @returns The stored credential string, or null if not found
   * @throws If the keychain is locked, access is denied, or another unexpected error occurs
   */
  public async read(): Promise<string | null> {
    try {
      const entry = new AsyncEntry(this.service, this.account);
      return (await entry.getPassword()) ?? null;
    } catch (error) {
      // NoEntry = credential not found in keychain — expected for first-run
      if (error instanceof Error && error.name === 'NoEntry') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Writes a credential value to the native keychain using the async API.
   * @param value - The credential string to store
   */
  public async write(value: string): Promise<void> {
    const entry = new AsyncEntry(this.service, this.account);
    await entry.setPassword(value);
  }
}

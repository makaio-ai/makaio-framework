import { AsyncEntry } from '@napi-rs/keyring';
import type { ICredentialBackend } from './credential-backend.js';

/** Secret-free failure from the native keychain boundary. */
class KeyringBackendError extends Error {
  /** @param operation - Stable native-keychain operation name. */
  public constructor(operation: 'read' | 'write' | 'clear') {
    super(`Native keychain credential ${operation} failed`);
    this.name = 'KeyringBackendError';
  }
}

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
   * errors (locked keychain, permission denied, etc.) are normalized without
   * exposing native keychain context.
   * @returns The stored credential string, or null if not found
   * @throws A secret-free error if the keychain is inaccessible.
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
      throw new KeyringBackendError('read');
    }
  }

  /**
   * Writes a credential value to the native keychain using the async API.
   * @param value - The credential string to store
   */
  public async write(value: string): Promise<void> {
    try {
      const entry = new AsyncEntry(this.service, this.account);
      await entry.setPassword(value);
    } catch {
      throw new KeyringBackendError('write');
    }
  }

  /** Remove the configured native-keychain credential when it exists. */
  public async clear(): Promise<void> {
    try {
      const entry = new AsyncEntry(this.service, this.account);
      await entry.deletePassword();
    } catch (error) {
      if (!(error instanceof Error && error.name === 'NoEntry')) throw new KeyringBackendError('clear');
    }
  }
}

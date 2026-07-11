/**
 * Lazy native-keyring bridge for Codex authentication storage.
 * @packageDocumentation
 */

/** Keyring operations used by the Codex native auth store. */
export interface CodexKeyringCredentialStore {
  /**
   * Read one credential.
   * @param service - Keyring service name.
   * @param account - Keyring account name.
   * @returns Stored value, or `null` when absent.
   */
  read(service: string, account: string): Promise<string | null>;
  /**
   * Write one credential.
   * @param service - Keyring service name.
   * @param account - Keyring account name.
   * @param value - Opaque credential payload.
   */
  write(service: string, account: string, value: string): Promise<void>;
  /**
   * Delete one credential, treating absence as success.
   * @param service - Keyring service name.
   * @param account - Keyring account name.
   */
  delete(service: string, account: string): Promise<void>;
}

/** Load the optional native keyring addon only when a keyring operation runs. */
let nativeKeyringModule: Promise<typeof import('@napi-rs/keyring')> | undefined;

/**
 * Create one native keyring entry without evaluating the addon on file-only paths.
 * @param service - Keyring service name.
 * @param account - Keyring account name.
 * @returns Native asynchronous keyring entry.
 */
async function createNativeKeyringEntry(
  service: string,
  account: string,
): Promise<import('@napi-rs/keyring').AsyncEntry> {
  nativeKeyringModule ??= import('@napi-rs/keyring');
  const { AsyncEntry } = await nativeKeyringModule;
  return new AsyncEntry(service, account);
}

/**
 * Check the portable keyring binding's missing-entry discriminator.
 * @param error - Keyring operation failure.
 * @returns Whether the keyring reports an absent entry.
 */
function isMissingKeyringEntry(error: unknown): boolean {
  return error instanceof Error && error.name === 'NoEntry';
}

/** Native cross-platform keyring implementation matching Codex's keyring-rs store. */
export const nativeKeyringCredentialStore: CodexKeyringCredentialStore = {
  async read(service, account) {
    try {
      return (await (await createNativeKeyringEntry(service, account)).getPassword()) ?? null;
    } catch (error) {
      if (isMissingKeyringEntry(error)) return null;
      throw error;
    }
  },
  async write(service, account, value) {
    await (await createNativeKeyringEntry(service, account)).setPassword(value);
  },
  async delete(service, account) {
    try {
      await (await createNativeKeyringEntry(service, account)).deleteCredential();
    } catch (error) {
      if (!isMissingKeyringEntry(error)) throw error;
    }
  },
};

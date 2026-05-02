import { keychainRead, keychainWrite } from '../utils/security-cli.js';
import type { ICredentialBackend } from './credential-backend.js';

/**
 * Keychain backend using macOS `/usr/bin/security` CLI.
 *
 * Pre-configured with a keychain service name and account. Uses the same
 * access pattern as Claude Code CLI itself — `security` is already in
 * Claude Code's keychain ACL trusted apps list.
 */
export class SecurityCliBackend implements ICredentialBackend {
  /**
   * @param service - The keychain service name (e.g. "Claude Code-credentials")
   * @param account - The keychain account name (e.g. the OS username)
   */
  public constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  /**
   * Reads the credential value from the macOS keychain.
   *
   * Returns null if the entry does not exist (exit code 44).
   * Rethrows ENOENT if `/usr/bin/security` itself is missing (non-macOS platform),
   * and rethrows all other errors (locked keychain, permission denied, etc.).
   * @returns The stored credential string, or null if not found
   */
  public async read(): Promise<string | null> {
    return keychainRead(this.service, this.account);
  }

  /**
   * Writes a credential value to the macOS keychain.
   *
   * Uses `-U` (update if exists) and `-X` (hex-encoded value) to match the
   * pattern used by Claude Code itself.
   * @param value - The credential string to store
   */
  public async write(value: string): Promise<void> {
    await keychainWrite(this.service, this.account, value);
  }
}

import type { ICredentialBackend } from '../../backends/credential-backend.js';

/**
 * In-memory credential backend for testing.
 * Implements ICredentialBackend without filesystem or keychain access.
 */
export class InMemoryBackend implements ICredentialBackend {
  private value: string | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }

  async clear(): Promise<void> {
    this.value = null;
  }

  /**
   * Set the stored value directly (test helper).
   * @param value - The value to store, or null to clear
   */
  set(value: string | null): void {
    this.value = value;
  }
}

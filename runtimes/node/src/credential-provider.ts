import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IDirectChannel, IMakaioBus } from '@makaio/bus-core';
import { openChannel, ChannelClosedError } from '@makaio/bus-core';
import type { CredentialRef } from '@makaio/contracts/config';
import { parseStoredCredentialRef } from '@makaio/contracts/config';
import { CredentialSubjects } from '@makaio/contracts';
import { resolveCredentialRef } from '@makaio/ai-adapters-core/config';

/**
 * Credential provider interface for resolving credential references.
 *
 * Implementations are platform-specific (e.g. Node.js keychain, stored refs).
 */
export interface CredentialProvider {
  /**
   * Resolve a credential reference to its runtime value.
   * @param ref - Credential reference string
   * @returns Resolved value, or null if unavailable
   */
  resolve(ref: CredentialRef): Promise<string | null>;
}

const execFileAsync = promisify(execFile);

/**
 * Node.js credential provider.
 *
 * Resolves env:, file:, and keychain: credential references.
 */
export class NodeCredentialProvider implements CredentialProvider {
  /**
   * Resolve a credential reference to its plaintext value.
   * @param ref - Credential reference (`env:`, `file:`, or `keychain:`)
   * @returns Resolved credential value, or null when unavailable
   */
  public async resolve(ref: CredentialRef): Promise<string | null> {
    return resolveCredentialRef(ref, {
      resolveKeychain: this.resolveKeychain,
    });
  }

  private async resolveKeychain(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

/** Prefix identifying account-manager credential references. */
const ACCOUNT_MANAGER_PREFIX = 'account-manager:';

/**
 * Credential provider that resolves stored refs via credential service.
 *
 * Falls back to NodeCredentialProvider for env/file/keychain refs.
 * Uses a lazy-opened DirectChannel for the channel-only `credential.get` subject.
 */
export class StoredCredentialProvider implements CredentialProvider {
  private readonly fallbackProvider = new NodeCredentialProvider();
  // The cached channel is intentionally long-lived (process lifetime). The
  // node runtime's destroy lifecycle tears down the bus context, which closes
  // all channels implicitly. An explicit close() method is not needed because
  // the provider is a singleton wired once during init and outlives all callers.
  /** Lazily-opened channel to the credentials endpoint. */
  private channelPromise?: Promise<IDirectChannel>;

  /**
   * Create a new stored credential provider.
   * @param bus - Bus instance for credential retrieval
   */
  public constructor(private readonly bus: IMakaioBus) {}

  /**
   * Resolve a credential reference, including stored refs.
   *
   * Handles the `stored:providerConfig:<configId>:<key>` format via
   * `CredentialSubjects.get` over an encrypted DirectChannel. Falls back to
   * NodeCredentialProvider for env:, file:, and keychain: refs.
   * @param ref - Credential reference to resolve
   * @returns Resolved credential value, or null when unavailable
   */
  public async resolve(ref: CredentialRef): Promise<string | null> {
    const parsed = parseStoredCredentialRef(ref);
    if (parsed) {
      const { configId, key } = parsed;
      // Retry once on ChannelClosedError: clear the stale cached channel and
      // re-open transparently so callers never see transient channel lifecycle failures.
      //
      // This retry-once pattern parallels RelayConnectionService.withCredentialChannel().
      // Both are kept local because they live in different host/runtime packages,
      // and the pattern is simple enough that a shared abstraction
      // would add indirection without meaningful DRY benefit.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const channel = await this.getChannel();
          const result = await channel.request(CredentialSubjects.get, { configId });
          return result.credentials?.[key] ?? null;
        } catch (e) {
          if (e instanceof ChannelClosedError) {
            this.channelPromise = undefined;
            if (attempt === 0) continue;
          }
          throw e;
        }
      }
    }

    if (ref.startsWith(ACCOUNT_MANAGER_PREFIX)) {
      console.warn(
        '[StoredCredentialProvider] account-manager: refs are account identifiers ' +
          'and cannot be resolved to credentials. The associated adapter should ' +
          'authenticate via its native credential store.',
      );
      return null;
    }

    // Guard against stale persisted credential refs that used the removed
    // `stored:adapter:` format. `parseStoredCredentialRef` only handles the
    // current `stored:providerConfig:` format, so any other `stored:` prefix
    // is unresolvable. Warn and return null so callers can surface the error.
    if (ref.startsWith('stored:')) {
      console.warn(
        `[StoredCredentialProvider] Unresolvable credential ref "${ref}". ` +
          `Only the "stored:providerConfig:" format is supported. ` +
          `Re-save the credential using the current format.`,
      );
      return null;
    }

    return this.fallbackProvider.resolve(ref);
  }

  /**
   * Lazily open (and cache) the encrypted channel to the credentials endpoint.
   *
   * The promise is cleared on `ChannelClosedError` (post-open channel closure)
   * and also on open failures so the next call always retries rather than
   * re-using a permanently-rejected or permanently-closed promise.
   * @returns The open DirectChannel
   */
  private getChannel(): Promise<IDirectChannel> {
    this.channelPromise ??= this.openCredentialChannel().catch((error) => {
      this.channelPromise = undefined;
      throw error;
    });
    return this.channelPromise;
  }

  /**
   * Open a fresh encrypted channel to the credentials endpoint.
   * @returns Newly opened DirectChannel
   */
  private async openCredentialChannel(): Promise<IDirectChannel> {
    const { token } = await this.bus.request(CredentialSubjects.getChannelToken, {});
    return openChannel(this.bus.getContext(), 'credentials', { token, transports: [] });
  }
}

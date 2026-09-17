import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type { IDirectChannel, IMakaioBus } from '@makaio/bus-core';
import { openChannel, ChannelClosedError } from '@makaio/bus-core';
import type { CredentialRef } from '@makaio/contracts/config';
import { parseStoredCredentialRef } from '@makaio/contracts/config';
import { CredentialSubjects } from '@makaio/contracts';
import type { CredentialResolver } from '@makaio/contracts/extension';
import { resolveCredentialRef } from '@makaio/ai-adapters-core/config';

/**
 * Credential provider for resolving credential references.
 *
 * Alias of {@link CredentialResolver} from `@makaio/contracts/extension` — the
 * contracts interface is the authoritative shape; this alias keeps existing
 * consumers that import from the runtime package working without duplication.
 */
export type CredentialProvider = CredentialResolver;

const execFileAsync = promisify(execFile);

/**
 * Node.js credential provider.
 *
 * Resolves env:, file:, and keychain: credential references.
 */
export class NodeCredentialProvider implements CredentialProvider {
  /**
   * Resolve a credential reference to its plaintext value.
   *
   * Returns null (never throws) for `stored:` refs — those require a
   * credential service handler registered on the bus. Returns null (never
   * throws) for `file:` refs that are missing or unreadable.
   * @param ref - Credential reference (`env:`, `file:`, or `keychain:`)
   * @returns Resolved credential value, or null when unavailable
   */
  public async resolve(ref: CredentialRef): Promise<string | null> {
    if (ref.startsWith('stored:')) {
      console.warn(
        `[NodeCredentialProvider] Cannot resolve "stored:" credential ref "${ref}": ` +
          `Register a credential service handler on this host to enable stored credential resolution.`,
      );
      return null;
    }
    return resolveCredentialRef(ref, {
      resolveKeychain: this.resolveKeychain,
      readFile: async (path) => {
        try {
          return await fs.readFile(path, 'utf-8');
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
          console.warn(`[NodeCredentialProvider] Cannot read file credential at "${path}" (${code}). Returning null.`);
          // Return an empty string so resolveCredentialRef's `.trim() || null` yields null.
          return '';
        }
      },
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

/**
 * Credential provider that resolves stored refs via credential service.
 *
 * Falls back to NodeCredentialProvider for env/file/keychain refs.
 * Uses a lazy-opened DirectChannel for the channel-only `credential.get` subject.
 */
export class StoredCredentialProvider implements CredentialProvider {
  private readonly fallbackProvider = new NodeCredentialProvider();
  /**
   * Lazily-opened channel to the credentials endpoint.
   *
   * Only set when a channel is successfully open. Cleared when the service is
   * absent (null return), on open failures, and on `ChannelClosedError` so
   * every subsequent call re-checks the bus via `requestOptional`.
   * Call {@link close} during host shutdown to release the channel explicitly.
   */
  private channelPromise?: Promise<IDirectChannel | null>;

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
        // Capture the promise used this iteration so we only clear the cache
        // when it still holds the stale entry — a concurrent caller may have
        // already replaced it with a fresh channel.
        const channelPromise = this.getChannel();
        try {
          const channel = await channelPromise;
          if (!channel) {
            // No credential service handler is registered (e.g. headless host
            // without a product credential service). Degrade gracefully.
            console.warn(
              `[StoredCredentialProvider] Cannot resolve "stored:" credential ref "${ref}": ` +
                `Register a credential service handler on this host to enable stored credential resolution.`,
            );
            return null;
          }
          const result = await channel.request(CredentialSubjects.get, { configId });
          return result.credentials?.[key] ?? null;
        } catch (e) {
          if (e instanceof ChannelClosedError) {
            if (this.channelPromise === channelPromise) {
              this.channelPromise = undefined;
            }
            if (attempt === 0) continue;
          }
          throw e;
        }
      }
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
   * Close and discard the cached channel. Safe to call multiple times (idempotent).
   *
   * Call during host shutdown before the bus/transport is torn down so the
   * channel is released cleanly rather than abandoned.
   */
  public close(): void {
    const stale = this.channelPromise;
    this.channelPromise = undefined;
    if (stale !== undefined) {
      void stale
        .then((ch) => {
          ch?.close();
        })
        .catch(() => {
          // Channel was never successfully opened or is already closed — nothing to do.
        });
    }
  }

  /**
   * Lazily open (and cache) the encrypted channel to the credentials endpoint.
   *
   * Only a successfully opened channel is cached. When the service is absent
   * (`openCredentialChannel` returns `null`), the promise is cleared so the
   * next call re-checks via `requestOptional` — the service may have registered
   * since this call. Open failures are also cleared so the next call retries
   * rather than re-using a permanently-rejected promise.
   * @returns The open DirectChannel, or null when no handler is registered
   */
  private getChannel(): Promise<IDirectChannel | null> {
    this.channelPromise ??= this.openCredentialChannel().then(
      (ch) => {
        // The credential service is not yet registered. Clear the cached promise
        // so the next call re-checks via requestOptional — the service may have
        // registered since. Only a successfully opened channel is kept in cache.
        if (ch === null) {
          this.channelPromise = undefined;
        }
        return ch;
      },
      (error) => {
        this.channelPromise = undefined;
        throw error;
      },
    );
    return this.channelPromise;
  }

  /**
   * Open a fresh encrypted channel to the credentials endpoint.
   *
   * Returns null when no `getChannelToken` handler is registered on the bus
   * (optional service — the credential service is not always present).
   * @returns Newly opened DirectChannel, or null when the service is absent
   */
  private async openCredentialChannel(): Promise<IDirectChannel | null> {
    const result = await this.bus.requestOptional(CredentialSubjects.getChannelToken, {});
    if (!result.handled) {
      return null;
    }
    const { token } = result.data;
    return openChannel(this.bus.getContext(), 'credentials', { token, transports: [] });
  }
}
